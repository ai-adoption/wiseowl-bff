import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient as createDeepgramClient } from '@deepgram/sdk';

const fastify = Fastify({ logger: true });

// Env vars (set in Render)
const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const WELCOME_MESSAGE =
  process.env.WELCOME_MESSAGE || "Hi! You're through to WiseOwl. How can I help?";

// Clients
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const deepgram = createDeepgramClient(DEEPGRAM_API_KEY);

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Twilio <-> WS
const wss = new WebSocketServer({ noServer: true });

// Fix Twilio send helper
const WS_OPEN = 1;
const twilioSend = (ws, obj) => {
  if (ws && ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify(obj));
  }
};

// Split μ-law buffer into 20ms (160 byte) frames
function ulawChunks(buf) {
  const chunks = [];
  const size = 160;
  for (let i = 0; i < buf.length; i += size) {
    chunks.push(buf.slice(i, i + size));
  }
  return chunks;
}

// Handle new Twilio WS connections
wss.on('connection', async (twilioWS, req) => {
  const callSid = new URL(req.url, `http://${req.headers.host}`).searchParams.get(
    'callSid'
  );
  fastify.log.info({ callSid }, 'Twilio WS connected');

  // Insert call record
  const { data: call } = await supabase
    .from('calls')
    .insert([{ call_sid: callSid, status: 'active' }])
    .select()
    .single();

  // === Deepgram Realtime ASR ===
  const dgConn = deepgram.listen.live({
    model: 'nova-2',
    encoding: 'mulaw',
    sample_rate: 8000,
    interim_results: true,
    smart_format: true,
    endpointing: 1500,
    utterance_end_ms: 1200
  });

  let dgReady = false;
  dgConn.on('open', () => {
    dgReady = true;
    fastify.log.info({ callSid }, 'Deepgram live: open');
  });
  dgConn.on('close', () => {
    dgReady = false;
    fastify.log.info({ callSid }, 'Deepgram live: closed');
  });

  // Buffer for user transcript
  let buffer = '';
  let processing = false;

 // === ElevenLabs realtime TTS ===
const { default: WebSocket } = await import('ws');

const elevenURL = `wss://api.elevenlabs.io/v1/realtime/sse?voice_id=${process.env.ELEVEN_VOICE_ID}&model_id=eleven_turbo_v2_5&output_format=ulaw_8000`;

const elevenWS = new WebSocket(elevenURL, {
  headers: {
    'xi-api-key': process.env.ELEVEN_API_KEY,
    'Accept': 'application/json'
  }
});

// Keep ping alive
const elevenPing = setInterval(() => {
  if (elevenWS.readyState === WebSocket.OPEN) {
    elevenWS.ping();
  }
}, 20000);

elevenWS.on('open', () => {
  fastify.log.info('ElevenLabs WS connected');
  // Optional: prime session
  elevenWS.send(JSON.stringify({
    text: " ",
    voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    generation_config: { chunk_length_schedule: [120, 160, 250, 290] }
  }));
});

elevenWS.on('message', (data) => {
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
      twilioSend(twilioWS, { event: 'mark', mark: { name: 'playback_complete' } });
    }
  } catch (err) {
    fastify.log.error({ err }, 'ElevenLabs message error');
  }
});

elevenWS.on('close', () => {
  fastify.log.info('ElevenLabs WS closed');
  clearInterval(elevenPing);
});

elevenWS.on('error', (err) => {
  fastify.log.error({ err }, 'ElevenLabs WS error');
});

  const elevenPing = setInterval(() => {
    if (elevenWS.readyState === WS_OPEN) {
      elevenWS.ping();
    }
  }, 20000);

  elevenWS.on('open', () => {
    fastify.log.info({ callSid }, 'ElevenLabs WS: open');

    // Prime session
    elevenWS.send(
      JSON.stringify({
        text: ' ',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        generation_config: { chunk_length_schedule: [120, 160, 250, 290] }
      })
    );

    // 🔊 Send welcome message
    elevenWS.send(
      JSON.stringify({
        text: WELCOME_MESSAGE,
        try_trigger_generation: true
      })
    );
  });

  elevenWS.on('message', (data) => {
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
        twilioSend(twilioWS, { event: 'mark', mark: { name: 'playback_complete' } });
      }
    } catch (e) {
      // ignore non-JSON (pongs, etc.)
    }
  });

  elevenWS.on('close', () => fastify.log.info({ callSid }, 'ElevenLabs WS: closed'));
  elevenWS.on('error', (e) =>
    fastify.log.error({ err: e }, 'ElevenLabs WS error')
  );

  // === Deepgram transcript events ===
  dgConn.on('transcript', async (evt) => {
    const transcript = evt.channel?.alternatives?.[0]?.transcript;
    if (!transcript) return;

    if (evt.is_final || evt.speech_final) {
      buffer += transcript + ' ';
      fastify.log.info({ callSid, transcript }, 'Final transcript');

      if (!processing) {
        processing = true;
        await processWithClaude(buffer.trim());
        buffer = '';
        processing = false;
      }
    } else {
      fastify.log.info({ callSid, transcript }, 'Interim');
    }
  });

  // === Process with Claude ===
  async function processWithClaude(text) {
    try {
      // Save user turn
      await supabase.from('turns').insert([
        { call_id: call.id, role: 'user', content: text }
      ]);

      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 500,
        messages: [{ role: 'user', content: text }],
        tools: [
          {
            name: 'receptionist_response',
            description: 'Generate structured receptionist response',
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
          }
        ],
        tool_choice: { type: 'tool', name: 'receptionist_response' }
      });

      let result;
      if (response.content[0].type === 'tool_use') {
        result = response.content[0].input;
      } else {
        result = {
          intent: 'unknown',
          response_text: "I'm sorry, could you repeat that?",
          escalate: false,
          slots: {}
        };
      }

      // Save assistant + intent
      await supabase.from('turns').insert([
        { call_id: call.id, role: 'assistant', content: result.response_text }
      ]);
      await supabase.from('intents').insert([
        {
          call_id: call.id,
          intent: result.intent,
          confidence: 1.0,
          slots: result.slots,
          escalate: result.escalate
        }
      ]);

      // Send to ElevenLabs
      elevenWS.send(JSON.stringify({ text: result.response_text, try_trigger_generation: true }));
    } catch (err) {
      fastify.log.error({ err }, 'Claude processing error');
      elevenWS.send(JSON.stringify({ text: "I'm sorry, I didn't catch that." }));
    }
  }

  // === Handle Twilio WS messages ===
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      switch (msg.event) {
        case 'start':
          fastify.log.info({ callSid }, 'Twilio stream started');
          break;
        case 'media':
          if (dgConn && dgReady) {
            const audio = Buffer.from(msg.media?.payload || '', 'base64');
            if (audio.length) dgConn.send(audio);
          }
          break;
        case 'stop':
          fastify.log.info({ callSid }, 'Twilio stream stopped');
          break;
      }
    } catch (err) {
      fastify.log.error({ err }, 'Error parsing Twilio WS message');
    }
  });

  twilioWS.on('close', async () => {
    fastify.log.info({ callSid }, 'Twilio WS closed');
    dgConn.finish();
    clearInterval(elevenPing);
    elevenWS.close();
    await supabase.from('calls').update({ status: 'completed' }).eq('id', call.id);
  });
});

// Upgrade HTTP to WS
fastify.server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/stream')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

// Start server
fastify.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  fastify.log.info(`Server running on port ${PORT}`);
});
