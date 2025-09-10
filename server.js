// server.js
// WiseOwl BFF: Twilio Media Streams  ⟶  Deepgram (ASR)  ⟶  Claude (reasoning)  ⟶  ElevenLabs (realtime TTS)
// Environment (Render): PORT, DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, ELEVEN_API_KEY, ELEVEN_VOICE_ID,
//                       SUPABASE_URL, SUPABASE_SERVICE_ROLE, (optional) CLAUDE_MODEL, (optional) JWT_SECRET

import Fastify from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

// ---- Env ----
const {
  PORT,
  DEEPGRAM_API_KEY,
  ANTHROPIC_API_KEY,
  ELEVEN_API_KEY,
  ELEVEN_VOICE_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  CLAUDE_MODEL = 'claude-3-5-sonnet-20241022',
} = process.env;

// ---- App ----
const fastify = Fastify({ logger: true });
const port = Number(PORT || 3000);

// Healthcheck
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// ---- Clients ----
const deepgram = createDeepgramClient(DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---- Utility: μ-law 8kHz frames (20ms = 160 bytes) for Twilio ----
function* ulawChunks(buf, size = 160) {
  for (let i = 0; i < buf.length; i += size) yield buf.slice(i, i + size);
}

function twilioSend(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// ---- Start server & WS endpoint for Twilio Media Streams ----
async function start() {
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info(`Server listening on 0.0.0.0:${port}`);

  const wss = new WebSocketServer({ server: fastify.server, path: '/stream' });

  wss.on('connection', async (twilioWS, req) => {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const callSid = params.get('callSid') || 'unknown';

    fastify.log.info({ callSid }, 'Twilio WS connected');

    // ----- Supabase: open call record -----
    const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
    let currentCall = null;
    try {
      const { data, error } = await supabase
        .from('calls')
        .upsert(
          { call_sid: callSid, status: 'active', started_at: new Date() },
          { onConflict: 'call_sid' }
        )
        .select()
        .single();
      if (error) throw error;
      currentCall = data;
    } catch (e) {
      fastify.log.warn({ err: e, callSid }, 'Supabase: could not upsert calls row');
    }

    // ----- Deepgram: listen.live (μ-law 8kHz mono) -----
    let dg;
    try {
      dg = deepgram.listen.live({
        encoding: 'mulaw',
        sample_rate: 8000,
        interim_results: true,
        smart_format: true,
        endpointing: 1500,
        utterance_end_ms: 1200,
        channels: 1,
        model: 'nova-2',
      });

      dg.on('open', () => fastify.log.info({ callSid }, 'Deepgram live: open'));
      dg.on('error', (e) => fastify.log.error({ err: e, callSid }, 'Deepgram live: error'));
      dg.on('close', () => fastify.log.info({ callSid }, 'Deepgram live: closed'));
    } catch (e) {
      fastify.log.error({ err: e, callSid }, 'Failed to open Deepgram live');
    }

    // ----- ElevenLabs: realtime TTS (stream-input) -----
    // NOTE: the audio we request is ulaw_8000 (already μ-law at 8kHz) to send straight to Twilio
    const elevenURL =
      `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}` +
      `/stream-input?model_id=eleven_turbo_v2_5&output_format=ulaw_8000`;

    const elevenWS = new WebSocket(elevenURL, { headers: { 'xi-api-key': ELEVEN_API_KEY } });

    const elevenPing = setInterval(() => {
      if (elevenWS.readyState === WebSocket.OPEN) elevenWS.ping();
    }, 20000);

    elevenWS.on('open', () => {
      fastify.log.info({ callSid }, 'ElevenLabs WS: open');
      elevenReady = true;
      
      // Prime session to reduce first-audio latency
      elevenWS.send(
        JSON.stringify({
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
        })
      );
      fastify.log.info({ callSid }, 'ElevenLabs: sent init message');
      
      // Send welcome message immediately as fallback (don't wait for Twilio start)
      setTimeout(() => {
        try {
          const welcomeText = process.env.WELCOME_MESSAGE || "Hello, this is WiseOwl speaking. How can I help you today?";
          fastify.log.info({ callSid, welcomeText, readyState: elevenWS.readyState }, 'ElevenLabs: sending immediate welcome message');
          
          if (elevenWS.readyState === WebSocket.OPEN) {
            elevenWS.send(
              JSON.stringify({
                text: welcomeText,
                try_trigger_generation: true,
              })
            );
            fastify.log.info({ callSid }, 'ElevenLabs: welcome message sent successfully');
          } else {
            fastify.log.error({ callSid, readyState: elevenWS.readyState }, 'ElevenLabs: cannot send welcome - connection not open');
          }
        } catch (err) {
          fastify.log.error({ err, callSid }, 'ElevenLabs: failed to send welcome message');
        }
      }, 1000);
    });

    elevenWS.on('message', (data) => {
      // ElevenLabs realtime messages are JSON; audio frames are base64 μ-law
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.audio) {
          const audio = Buffer.from(msg.audio, 'base64');
          fastify.log.debug({ callSid, audioBytes: audio.length, twilioReady }, 'ElevenLabs: received audio');
          
          // Send audio regardless of twilioReady state - let Twilio buffer it
          let chunkCount = 0;
          for (const chunk of ulawChunks(audio)) {
            twilioSend(twilioWS, { event: 'media', media: { payload: chunk.toString('base64') } });
            chunkCount++;
          }
          fastify.log.debug({ callSid, chunkCount, twilioReady }, 'ElevenLabs: forwarded audio chunks to Twilio');
        }
        if (msg.isFinal) {
          fastify.log.debug({ callSid }, 'ElevenLabs: generation complete');
          // mark after playback complete (helps keep Twilio/Eleven state in sync)
          twilioSend(twilioWS, { event: 'mark', mark: { name: 'playback_complete' } });
        }
      } catch {
        // ignore non-JSON (e.g., pongs)
      }
    });

    elevenWS.on('close', () => fastify.log.info({ callSid }, 'ElevenLabs WS: closed'));
    elevenWS.on('error', (e) => fastify.log.error({ err: e, callSid }, 'ElevenLabs WS error'));

    // ----- Transcript accumulation & turn-taking -----
    let buffer = '';
    let working = false;

    const processWithClaude = async (finalText) => {
      try {
        // Save user turn
        if (currentCall?.id) {
          await supabase.from('turns').insert([
            { call_id: currentCall.id, role: 'user', content: finalText, created_at: new Date() },
          ]);
        }

        // Ask Claude with a tool schema so we always get a structured reply
        const resp = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 1000,
          messages: [
            {
              role: 'user',
              content: `You are an efficient, polite AI receptionist. Keep responses concise.\nCaller said: "${finalText}"`,
            },
          ],
          tools: [
            {
              name: 'receptionist_response',
              description: 'Return intent, response_text, escalate flag, and slots object',
              input_schema: {
                type: 'object',
                properties: {
                  intent: { type: 'string' },
                  response_text: { type: 'string' },
                  escalate: { type: 'boolean' },
                  slots: { type: 'object', additionalProperties: true },
                },
                required: ['intent', 'response_text', 'escalate', 'slots'],
              },
            },
          ],
          tool_choice: { type: 'tool', name: 'receptionist_response' },
        });

        let result;
        if (resp.content?.[0]?.type === 'tool_use') {
          result = resp.content[0].input;
        } else {
          result = {
            intent: 'unknown',
            response_text: 'Thanks—how can I help you today?',
            escalate: false,
            slots: {},
          };
        }

        // Validate / auto-repair
        if (!result.intent) result.intent = 'unknown';
        if (!result.response_text) result.response_text = 'How can I help?';
        if (typeof result.escalate !== 'boolean') result.escalate = false;
        if (!result.slots || typeof result.slots !== 'object') result.slots = {};

        // Save assistant turn & intent
        if (currentCall?.id) {
          await Promise.all([
            supabase
              .from('turns')
              .insert([
                {
                  call_id: currentCall.id,
                  role: 'assistant',
                  content: result.response_text,
                  created_at: new Date(),
                },
              ]),
            supabase
              .from('intents')
              .insert([
                {
                  call_id: currentCall.id,
                  intent: result.intent,
                  confidence: 1.0,
                  slots: result.slots,
                  escalate: result.escalate,
                  created_at: new Date(),
                },
              ]),
          ]);
        }

        // Barge-in: clear Twilio audio buffer, then speak
        twilioSend(twilioWS, { event: 'clear' });
        if (elevenWS.readyState === WebSocket.OPEN) {
          elevenWS.send(
            JSON.stringify({
              text: result.response_text,
              try_trigger_generation: true,
            })
          );
        }
      } catch (err) {
        fastify.log.error({ err, callSid }, 'Claude processing failed');
        // Fallback TTS
        if (elevenWS.readyState === WebSocket.OPEN) {
          elevenWS.send(
            JSON.stringify({
              text: "I'm sorry—I didn’t catch that. Could you repeat?",
              try_trigger_generation: true,
            })
          );
        }
      }
    };

    // Deepgram events
    dg?.on('transcript', async (evt) => {
      const t = evt?.channel?.alternatives?.[0]?.transcript;
      if (!t) return;

      if (evt.is_final || evt.speech_final) {
        buffer += t + ' ';
        fastify.log.info({ callSid, text: t }, 'ASR final');

        if (!working) {
          working = true;
          const finalText = buffer.trim();
          buffer = '';
          await processWithClaude(finalText);
          working = false;
        }
      } else {
        fastify.log.debug({ callSid, text: t }, 'ASR interim');
      }
    });

    dg?.on('utteranceEnd', async () => {
      if (buffer.trim() && !working) {
        working = true;
        const finalText = buffer.trim();
        buffer = '';
        await processWithClaude(finalText);
        working = false;
      }
    });

    // ----- Twilio sync state -----
    let twilioReady = false;
    let elevenReady = false;

    // ----- Twilio WS messages -----
    twilioWS.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));

        switch (msg.event) {
          case 'start':
            fastify.log.info({ callSid, streamSid: msg.start?.streamSid }, 'Twilio stream started');
            twilioReady = true;
            twilioSend(twilioWS, { event: 'clear' });
            
            // Wait a moment for Twilio to be fully ready, then send welcome
            setTimeout(() => {
              if (elevenWS.readyState === WebSocket.OPEN) {
                const welcomeText = process.env.WELCOME_MESSAGE || "Hello, this is WiseOwl speaking. How can I help you today?";
                fastify.log.info({ callSid, welcomeText }, 'Sending welcome message to ElevenLabs');
                elevenWS.send(
                  JSON.stringify({
                    text: welcomeText,
                    try_trigger_generation: true,
                  })
                );
              } else {
                fastify.log.warn({ callSid, readyState: elevenWS.readyState }, 'ElevenLabs not ready for welcome message');
              }
            }, 500);
            break;

          case 'media': {
            // base64 μ-law 8kHz audio from Twilio → Deepgram
            const audio = Buffer.from(msg.media?.payload ?? '', 'base64');
            if (audio.length && dg?.readyState === WebSocket.OPEN) dg.send(audio);
            break;
          }

          case 'mark':
            fastify.log.debug({ callSid, mark: msg.mark?.name }, 'Twilio mark');
            break;

          case 'stop':
            fastify.log.info({ callSid }, 'Twilio stream stopped');
            break;
        }
      } catch (e) {
        fastify.log.error({ err: e, callSid }, 'Twilio message parse error');
      }
    });

    // ----- Cleanup -----
    const cleanup = async () => {
      try {
        dg?.finish?.();
      } catch {}
      try {
        elevenWS?.close?.();
      } catch {}
      clearInterval(elevenPing);

      if (currentCall?.id) {
        try {
          await supabase.from('calls').update({ status: 'completed', ended_at: new Date() }).eq('id', currentCall.id);
        } catch (e) {
          fastify.log.warn({ err: e, callSid }, 'Supabase: could not update call end');
        }
      }
    };

    twilioWS.on('close', async () => {
      fastify.log.info({ callSid }, 'WebSocket closed');
      await cleanup();
    });

    twilioWS.on('error', async (e) => {
      fastify.log.error({ err: e, callSid }, 'WebSocket error');
      await cleanup();
    });
  });
}

start().catch((e) => {
  fastify.log.error(e);
  process.exit(1);
});
