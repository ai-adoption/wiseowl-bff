// server.js (ESM)
// Minimal Fastify + ws BFF for Twilio Media Streams -> Deepgram -> Claude -> ElevenLabs
//
// ── Required ENV ──────────────────────────────────────────────────────────────
// PORT                         (e.g. 3000; Render provides one for you)
// DEEPGRAM_API_KEY             (Deepgram API key)
// ANTHROPIC_API_KEY            (Anthropic Claude API key)
// CLAUDE_MODEL                 (optional, default: "claude-3-5-sonnet-20241022")
// ELEVEN_API_KEY               (ElevenLabs API key)
// ELEVEN_VOICE_ID              (ElevenLabs voice ID for realtime TTS)
// SUPABASE_URL                 (Supabase project URL)
// SUPABASE_SERVICE_ROLE        (Supabase service-role key)
// JWT_SECRET                   (arbitrary string; for future JWT use)
// ─────────────────────────────────────────────────────────────────────────────

import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { fetch } from 'undici';

// ---------------------- Boot --------------------------------------------------

const fastify = Fastify({ logger: true });
const PORT = Number(process.env.PORT || 3000);

const DG = createDeepgramClient(process.env.DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;

if (!process.env.DEEPGRAM_API_KEY || !process.env.ANTHROPIC_API_KEY || !ELEVEN_API_KEY || !ELEVEN_VOICE_ID || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) {
  console.error('❌ Missing one or more required environment variables.');
}

// ---------------------- Health ------------------------------------------------

fastify.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString()
}));

// ---------------------- Helpers ----------------------------------------------

/** Sleep helper */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send Twilio MediaStream control events */
const twilioSend = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

/** Chunk a Buffer to 20ms @ 8kHz μ-law (160 bytes) */
function* ulawChunks(buf) {
  const size = 160;
  for (let i = 0; i < buf.length; i += size) {
    yield buf.slice(i, i + size);
  }
}

/** Very small schema “guard” for Claude tool output */
function normalizeToolResult(res) {
  const out = {
    intent: 'unknown',
    response_text: 'How can I help you?',
    escalate: false,
    slots: {}
  };
  if (res && typeof res === 'object') {
    if (typeof res.intent === 'string' && res.intent.trim()) out.intent = res.intent.trim();
    if (typeof res.response_text === 'string' && res.response_text.trim()) out.response_text = res.response_text.trim();
    if (typeof res.escalate === 'boolean') out.escalate = res.escalate;
    if (res.slots && typeof res.slots === 'object') out.slots = res.slots;
  }
  return out;
}

// ---------------------- WS: /stream (Twilio) ---------------------------------

const wss = new WebSocketServer({ noServer: true });

// Fastify HTTP server upgrade -> our WS server
fastify.server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  if (!url || !url.startsWith('/stream')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (twilioWS, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('callSid') || 'unknown';
  fastify.log.info({ callSid }, 'Twilio WS connected');

  // Persist call row
  let callRow = null;
  try {
    const { data, error } = await supabase
      .from('calls')
      .insert([{ call_sid: callSid, status: 'active', started_at: new Date() }])
      .select()
      .single();
    if (error) throw error;
    callRow = data;
  } catch (e) {
    fastify.log.error({ err: e }, 'Supabase: create call failed');
  }

  // Keep-alive to avoid idle close (Twilio tolerates unused messages)
  const keepAlive = setInterval(() => {
    if (twilioWS.readyState === twilioWS.OPEN) {
      twilioWS.ping?.();
    }
  }, 20000);

  // ---------------- Deepgram realtime (μ-law, 8k) ---------------------------

  const dgConn = DG.listen.live({
    model: 'nova-2',
    encoding: 'mulaw',
    sample_rate: 8000,
    interim_results: true,
    smart_format: true,
    endpointing: 1500,
    utterance_end_ms: 1200,
    channels: 1
  });

  dgConn.on('open', () => fastify.log.info({ callSid }, 'Deepgram live: open'));
  dgConn.on('error', (e) => fastify.log.error({ err: e }, 'Deepgram error'));
  dgConn.on('close', () => fastify.log.info({ callSid }, 'Deepgram live: closed'));

  // Buffer final text until an endpoint
  let pendingText = '';
  let processing = false;

  // ---------------- ElevenLabs realtime TTS ---------------------------------
 function connectElevenLabs(ws /* Twilio WS */) {
  const voiceId = process.env.ELEVEN_VOICE_ID; // <-- from Render env
  const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_turbo_v2_5&output_format=ulaw_8000`;

  // Pass API key in WS headers
  const elevenLabsWs = new WebSocket(wsUrl, {
    headers: { 'xi-api-key': process.env.ELEVEN_API_KEY }
  });

  elevenLabsWs.on('open', () => {
    console.log('ElevenLabs WebSocket connected');

    // Initial server-side config (keep)
    elevenLabsWs.send(JSON.stringify({
      text: ' ',
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      generation_config: { chunk_length_schedule: [120, 160, 250, 290] }
    }));

    // 🔊 Send the welcome message immediately
    const welcome = process.env.WELCOME_MESSAGE || "Hi! You're through to WiseOwl. How can I help?";
    elevenLabsWs.send(JSON.stringify({
      text: welcome,
      try_trigger_generation: true
    }));
  });

  elevenLabsWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.audio) {
        const audioBuffer = Buffer.from(msg.audio, 'base64');
        const chunkSize = 160; // 20ms at 8kHz μ-law
        for (let i = 0; i < audioBuffer.length; i += chunkSize) {
          const chunk = audioBuffer.slice(i, i + chunkSize);
          const payload = chunk.toString('base64');
          ws.send(JSON.stringify({ event: 'media', media: { payload } }));
        }
      }
      if (msg.isFinal) {
        ws.send(JSON.stringify({ event: 'mark', mark: { name: 'playback_complete' } }));
      }
    } catch (err) {
      console.error('Error processing ElevenLabs audio:', err);
    }
  });

  elevenLabsWs.on('error', (err) => console.error('ElevenLabs WS error:', err));
  elevenLabsWs.on('close', () => console.log('ElevenLabs WS closed'));
  return elevenLabsWs;
}

    const elevenPing = setInterval(() => {
      if (elevenWS.readyState === elevenWS.OPEN) {
        elevenWS.ping();
      }
    }, 20000);

    elevenWS.on('open', () => {
      fastify.log.info({ callSid }, 'ElevenLabs WS: open');

      // (Optional) prime session with basic settings to reduce first-audio delay
      const init = {
        text: ' ',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        generation_config: { chunk_length_schedule: [120, 160, 250, 290] }
      };
      elevenWS.send(JSON.stringify(init));
    });

    elevenWS.on('message', (data) => {
      // ElevenLabs realtime sends small JSON envelopes; audio payload is base64
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.audio) {
          const audio = Buffer.from(msg.audio, 'base64');
          for (const chunk of ulawChunks(audio)) {
            twilioSend(twilioWS, {
              event: 'media',
              media: { payload: chunk.toString('base64') }
            });
          }
        }
        if (msg.isFinal) {
          // Signal playback complete (helps if you chain prompts)
          twilioSend(twilioWS, { event: 'mark', mark: { name: 'playback_complete' } });
        }
      } catch (e) {
        // Some messages aren’t JSON (pongs). Ignore safely.
      }
    });

    elevenWS.on('close', () => fastify.log.info({ callSid }, 'ElevenLabs WS: closed'));
    elevenWS.on('error', (e) => fastify.log.error({ err: e }, 'ElevenLabs WS error'));

    // --------------- Deepgram -> Claude -> ElevenLabs pipeline --------------

    const runClaude = async (finalText) => {
      try {
        // Save user turn
        await supabase.from('turns').insert([{
          call_id: callRow?.id ?? null,
          role: 'user',
          content: finalText,
          created_at: new Date()
        }]);

        // Ask Claude with a structured tool output
        const resp = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `You are WiseOwl, a helpful AI receptionist. Be concise, warm, and helpful.\nCaller said: "${finalText}"`
          }],
          tools: [{
            name: 'receptionist_response',
            description: 'Return an actionable reply for a caller.',
            input_schema: {
              type: 'object',
              properties: {
                intent: { type: 'string' },
                response_text: { type: 'string' },
                escalate: { type: 'boolean' },
                slots: { type: 'object', additionalProperties: true }
              },
              required: ['intent', 'response_text', 'escalate', 'slots']
            }
          }],
          tool_choice: { type: 'tool', name: 'receptionist_response' }
        });

        let tool;
        const first = resp.content[0];
        if (first?.type === 'tool_use' && first.name === 'receptionist_response') {
          tool = first.input;
        }
        const out = normalizeToolResult(tool);

        // Save assistant turn + intent
        await Promise.all([
          supabase.from('turns').insert([{
            call_id: callRow?.id ?? null,
            role: 'assistant',
            content: out.response_text,
            created_at: new Date()
          }]),
          supabase.from('intents').insert([{
            call_id: callRow?.id ?? null,
            intent: out.intent,
            confidence: 1.0,
            slots: out.slots,
            escalate: out.escalate,
            created_at: new Date()
          }])
        ]);

        // Barge-in: clear any playing audio on Twilio side
        twilioSend(twilioWS, { event: 'clear' });

        // Speak via ElevenLabs realtime
        if (elevenWS.readyState === elevenWS.OPEN) {
          elevenWS.send(JSON.stringify({
            text: out.response_text,
            try_trigger_generation: true
          }));
        }
      } catch (e) {
        fastify.log.error({ err: e }, 'Claude pipeline error');

        twilioSend(twilioWS, { event: 'clear' });
        if (elevenWS.readyState === elevenWS.OPEN) {
          elevenWS.send(JSON.stringify({
            text: "I'm sorry, I didn’t catch that. Could you say that again?",
            try_trigger_generation: true
          }));
        }
      }
    };

    // Deepgram transcripts
    dgConn.on('transcript', async (dg) => {
      const text = dg?.channel?.alternatives?.[0]?.transcript || '';
      if (!text) return;

      if (dg.speech_final || dg.is_final) {
        pendingText += (pendingText ? ' ' : '') + text;
        fastify.log.info({ callSid, text }, 'Deepgram final');

        if (!processing) {
          processing = true;
          const toProcess = pendingText.trim();
          pendingText = '';
          await runClaude(toProcess);
          processing = false;
        }
      } else {
        // interim
        fastify.log.debug({ callSid, text }, 'Deepgram interim');
      }
    });

    dgConn.on('utteranceEnd', async () => {
      if (pendingText && !processing) {
        processing = true;
        const toProcess = pendingText.trim();
        pendingText = '';
        await runClaude(toProcess);
        processing = false;
      }
    });

    // --------------- Twilio inbound media handling ---------------------------

    let streamSid = null;

    twilioWS.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        switch (msg.event) {
          case 'start':
            streamSid = msg.start?.streamSid || streamSid;
            fastify.log.info({ callSid, streamSid }, 'Twilio start');
            break;

          case 'media': {
            // Twilio sends μ-law base64 frames; forward to Deepgram
            if (dgConn && dgConn.send) {
              const audio = Buffer.from(msg.media?.payload || '', 'base64');
              if (audio.length) dgConn.send(audio);
            }
            break;
          }

          case 'mark':
            fastify.log.info({ callSid, mark: msg.mark?.name }, 'Twilio mark');
            break;

          case 'stop':
            fastify.log.info({ callSid, streamSid }, 'Twilio stop');
            cleanup();
            break;
        }
      } catch (e) {
        fastify.log.error({ err: e }, 'Twilio WS message parse error');
      }
    });

    twilioWS.on('close', () => {
      fastify.log.info({ callSid }, 'Twilio WS closed');
      cleanup();
    });

    twilioWS.on('error', (e) => {
      fastify.log.error({ err: e }, 'Twilio WS error');
      cleanup();
    });

    async function cleanup() {
      clearInterval(keepAlive);
      clearInterval(elevenPing);

      try { dgConn.finish?.(); } catch {}
      try { elevenWS.close?.(); } catch {}

      if (callRow?.id) {
        try {
          await supabase.from('calls')
            .update({ status: 'completed', ended_at: new Date() })
            .eq('id', callRow.id);
        } catch (e) {
          fastify.log.error({ err: e }, 'Supabase: update call failed');
        }
      }
    }
  }).catch((e) => {
    fastify.log.error({ err: e }, 'Failed to load ws module for ElevenLabs');
  });
});

// ---------------------- Start -------------------------------------------------

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Server listening on 0.0.0.0:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
