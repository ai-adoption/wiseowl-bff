/**
 * WiseOwl BFF — server.js
 * Fastify HTTP server + WebSocket bridge for Twilio Media Streams
 * Deepgram (ASR) → Anthropic Claude (reasoning) → ElevenLabs (TTS)
 * Supabase for persistence
 *
 * Env vars required:
 *  PORT                   - server port (Render provides one)
 *  DEEPGRAM_API_KEY       - Deepgram API key for ASR
 *  ANTHROPIC_API_KEY      - Claude API key
 *  CLAUDE_MODEL           - Claude model id (e.g., claude-3-7-sonnet-latest)
 *  ELEVEN_API_KEY         - ElevenLabs API key (TTS)
 *  ELEVEN_VOICE_ID        - ElevenLabs voice id
 *  SUPABASE_URL           - Supabase project URL
 *  SUPABASE_SERVICE_ROLE  - Supabase service role key
 *  JWT_SECRET             - (optional) secret for future WS auth
 */

import Fastify from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { fetch } from 'undici'; // kept for completeness; SDKs use fetch internally

// -------------------- Setup clients --------------------
const fastify = Fastify({ logger: true });
const port = process.env.PORT || 3000;

const deepgram = createDeepgramClient(process.env.DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// -------------------- Health --------------------
fastify.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

// -------------------- Helpers --------------------
const chunkUlaw = (buf, size = 160) => {
  const chunks = [];
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.slice(i, i + size));
  return chunks;
};

const sendClear = (ws) => ws.send(JSON.stringify({ event: 'clear' }));
const sendMark = (ws, name = 'playback_complete') =>
  ws.send(JSON.stringify({ event: 'mark', mark: { name } }));

// Persist a turn; non-blocking on failure
async function persistTurn({ call_sid, role, text, meta }) {
  try {
    await supabase.from('turns').insert([
      {
        call_sid,
        role,
        text,
        meta,
      },
    ]);
  } catch (e) {
    console.error('persistTurn error:', e);
  }
}

// Upsert call row
async function ensureCall(call_sid) {
  try {
    const { data } = await supabase
      .from('calls')
      .upsert({ call_sid }, { onConflict: 'call_sid' })
      .select()
      .single();
    return data;
  } catch (e) {
    console.error('ensureCall error:', e);
    return null;
  }
}

// -------------------- ElevenLabs WS (TTS) --------------------
function openElevenLabsWS() {
  const voiceId = process.env.ELEVEN_VOICE_ID;
  const model = 'eleven_turbo_v2_5';
  const output = 'ulaw_8000';
  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${model}&output_format=${output}`;

  const ws = new WebSocket(url, {
    headers: { 'xi-api-key': process.env.ELEVEN_API_KEY },
  });

  ws.on('open', () => {
    // optional initial config frame (kept minimal)
    ws.send(
      JSON.stringify({
        text: ' ',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
      })
    );
  });

  return ws;
}

// -------------------- Deepgram Live --------------------
function openDeepgramLive() {
  return deepgram.listen.live({
    model: 'nova-2',
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    interim_results: true,
    smart_format: true,
    endpointing: 1500,
    utterance_end_ms: 1200,
  });
}

// -------------------- Claude reasoning --------------------
async function reasonWithClaude(transcript) {
  try {
    const toolName = 'decide_and_respond';
    const res = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-3-7-sonnet-latest',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: `You are a polite, concise AI receptionist. Given this caller text, produce a structured response.\n\nCaller: "${transcript}"`,
        },
      ],
      tools: [
        {
          name: toolName,
          description:
            'Decide the caller intent, produce a brief response text, whether to escalate, and any extracted slots.',
          input_schema: {
            type: 'object',
            properties: {
              intent: { type: 'string' },
              response_text: { type: 'string' },
              escalate: { type: 'boolean' },
              slots: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['intent', 'response_text', 'escalate', 'slots'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: toolName },
    });

    // Extract tool output (with simple auto-repair)
    let result = {
      intent: 'unknown',
      response_text: "I'm here to help. How can I assist you?",
      escalate: false,
      slots: {},
    };

    const content = res?.content?.[0];
    if (content?.type === 'tool_use' && content?.input) {
      const i = content.input;
      result.intent = typeof i.intent === 'string' ? i.intent : result.intent;
      result.response_text =
        typeof i.response_text === 'string' ? i.response_text : result.response_text;
      result.escalate = typeof i.escalate === 'boolean' ? i.escalate : result.escalate;
      result.slots = i.slots && typeof i.slots === 'object' ? i.slots : result.slots;
    }

    return result;
  } catch (e) {
    console.error('Claude reasoning error:', e);
    return {
      intent: 'fallback',
      response_text: "I'm sorry, could you please repeat that?",
      escalate: false,
      slots: {},
    };
  }
}

// -------------------- WebSocket: /stream (Twilio Media Streams) --------------------
async function start() {
  try {
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`WiseOwl BFF running on ${port}`);

    const wss = new WebSocketServer({ server: fastify.server, path: '/stream' });

    wss.on('connection', async (ws, req) => {
      // Parse CallSid from query
      const u = new URL(req.url, `http://${req.headers.host}`);
      const callSid = u.searchParams.get('callSid') || 'unknown';
      console.log('Twilio WS connected:', callSid);

      // Session state
      let transcriptBuffer = '';
      let speaking = false;
      let dg = openDeepgramLive();
      let eleven = openElevenLabsWS();

      // DB: ensure call row exists
      await ensureCall(callSid);

      // Deepgram events
      dg.on('open', () => console.log('Deepgram live: open'));
      dg.on('error', (e) => console.error('Deepgram error:', e));
      dg.on('close', () => console.log('Deepgram live: closed'));

      dg.on('transcript', async (msg) => {
        const alt = msg?.channel?.alternatives?.[0];
        const text = alt?.transcript || '';
        if (!text) return;

        if (msg.is_final || msg.speech_final) {
          transcriptBuffer += text + ' ';
          // Got a full piece of speech → reason → speak
          const userText = transcriptBuffer.trim();
          transcriptBuffer = '';

          // Persist user turn
          persistTurn({ call_sid: callSid, role: 'user', text: userText, meta: { final: true } });

          const result = await reasonWithClaude(userText);

          // Persist assistant + intents
          persistTurn({
            call_sid: callSid,
            role: 'assistant',
            text: result.response_text,
            meta: { intent: result.intent, escalate: result.escalate, slots: result.slots },
          });
          try {
            await supabase.from('intents').insert([
              {
                call_sid: callSid,
                intent: result.intent,
                escalate: result.escalate,
                slots: result.slots,
              },
            ]);
          } catch (e) {
            console.error('persist intent error:', e);
          }

          // Barge-in: clear any current playback
          if (speaking) sendClear(ws);

          // Speak via ElevenLabs
          if (eleven.readyState === WebSocket.OPEN) {
            speaking = true;
            eleven.send(JSON.stringify({ text: result.response_text, try_trigger_generation: true }));
          }
        } else {
          // interim: barge-in if caller starts talking while TTS
          if (!speaking) return;
          sendClear(ws);
          speaking = false;
        }
      });

      // ElevenLabs audio → Twilio
      eleven.on('message', (data) => {
        try {
          const m = JSON.parse(data.toString());
          if (m?.audio) {
            const audio = Buffer.from(m.audio, 'base64');
            // send as 20ms µ-law frames (160 bytes @ 8kHz)
            for (const chunk of chunkUlaw(audio, 160)) {
              ws.send(JSON.stringify({ event: 'media', media: { payload: chunk.toString('base64') } }));
            }
          }
          if (m?.isFinal) {
            sendMark(ws, 'tts_done');
            speaking = false;
          }
        } catch (e) {
          // Sometimes ElevenLabs sends non-JSON keepalives; ignore
        }
      });
      eleven.on('open', () => console.log('ElevenLabs WS: open'));
      eleven.on('error', (e) => console.error('ElevenLabs WS error:', e));
      eleven.on('close', () => console.log('ElevenLabs WS: closed'));

      // Twilio → events
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.event === 'start') {
            console.log('Twilio start:', msg?.start?.streamSid);
          } else if (msg.event === 'media') {
            // Forward audio to Deepgram (base64 µ-law)
            if (dg?.readyState === WebSocket.OPEN) {
              const buf = Buffer.from(msg.media.payload, 'base64');
              dg.send(buf);
            }
          } else if (msg.event === 'stop') {
            console.log('Twilio stop');
            ws.close();
          }
        } catch (e) {
          console.error('WS message parse error:', e);
        }
      });

      ws.on('close', async () => {
        try {
          dg?.finish?.();
        } catch (_) {}
        try {
          if (eleven?.readyState === WebSocket.OPEN) eleven.close();
        } catch (_) {}
        try {
          await supabase
            .from('calls')
            .update({ ended_at: new Date() })
            .eq('call_sid', callSid);
        } catch (e) {
          console.error('update call end error:', e);
        }
        console.log('Twilio WS closed:', callSid);
      });

      ws.on('error', (e) => console.error('Twilio WS error:', e));
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
