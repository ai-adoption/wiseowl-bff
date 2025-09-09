import Fastify from 'fastify';
     import { WebSocketServer } from 'ws';
     import { createClient } from
     '@deepgram/sdk';
     import { createClient as
     createSupabaseClient } from
     '@supabase/supabase-js';
     import Anthropic from '@anthropic-ai/sdk';
     import { fetch } from 'undici';

// Required environment variables:
// PORT - Server port (default: 3000)
// DEEPGRAM_API_KEY - Deepgram API key for ASR
// ANTHROPIC_API_KEY - Claude API key
// ELEVEN_API_KEY - ElevenLabs API key for TTS
// ELEVEN_VOICE_ID - ElevenLabs voice ID
// SUPABASE_URL - Supabase project URL
// SUPABASE_SERVICE_ROLE - Supabase service role key
// JWT_SECRET - Secret string for signing tokens



     const fastify = Fastify({ logger: true });
     const port = process.env.PORT || 3000;

     // Initialize clients
     const deepgram =
     createClient(process.env.DEEPGRAM_API_KEY);
     const anthropic = new Anthropic({ apiKey:
     process.env.ANTHROPIC_API_KEY });
     const supabase = createSupabaseClient(proces
     s.env.SUPABASE_URL,
     process.env.SUPABASE_SERVICE_ROLE);

     // Health check endpoint
     fastify.get('/health', async (request,
     reply) => {
       return { status: 'ok', timestamp: new
     Date().toISOString() };
     });

     // Start server
     const start = async () => {
       try {
         await fastify.listen({ port, host:
     '0.0.0.0' });
         console.log(`Server running on port 
     ${port}`);

         // WebSocket server for Twilio Media 
     Streams
         const wss = new WebSocketServer({
     server: fastify.server, path: '/stream' });

         wss.on('connection', async (ws, req) =>
     {
           const callSid = new URL(req.url,
     `http://${req.headers.host}`).searchParams.g
     et('callSid');
           console.log(`Media stream started for 
     CallSid: ${callSid}`);

           let currentCall = null;
           let currentTurn = null;
           let transcriptBuffer = '';
           let isProcessing = false;
           let elevenLabsWs = null;

           // Initialize call record in Supabase
           const initCall = async () => {
             const { data, error } = await
     supabase
               .from('calls')
               .insert([{ call_sid: callSid,
     status: 'active', started_at: new Date() }])
               .select()
               .single();

             if (error) {
               console.error('Error creating call
      record:', error);
               return null;
             }
             return data;
           };

           currentCall = await initCall();

           // Connect to Deepgram with µ-law 
     configuration
           const dgConnection =
     deepgram.listen.live({
             encoding: 'mulaw',
             sample_rate: 8000,
             interim_results: true,
             smart_format: true,
             endpointing: 1500,
             utterance_end_ms: 1200,
             channels: 1,
             model: 'nova-2'
           });

           // Connect to ElevenLabs WebSocket for
      TTS
           const connectElevenLabs = () => {
             const wsUrl =
     `wss://api.elevenlabs.io/v1/text-to-speech/p
     NInz6obpgDQGcFmaJgB/stream-input?model_id=el
     even_turbo_v2_5&output_format=ulaw_8000`;
             elevenLabsWs = new WebSocket(wsUrl);

             elevenLabsWs.on('open', () => {
               console.log('ElevenLabs WebSocket 
     connected');
               // Send initial configuration
               elevenLabsWs.send(JSON.stringify({
                 text: ' ',
                 voice_settings: { stability:
     0.5, similarity_boost: 0.8 },
                 generation_config: {
                   chunk_length_schedule: [120,
     160, 250, 290]
                 }
               }));
             });

             elevenLabsWs.on('message', (data) =>
      {
               try {
                 const message =
     JSON.parse(data);
                 if (message.audio) {
                   // Convert base64 audio to 
     µ-law and send to Twilio in 20ms chunks (160
      bytes)
                   const audioBuffer =
     Buffer.from(message.audio, 'base64');
                   const chunkSize = 160; // 20ms
      at 8kHz µ-law

                   for (let i = 0; i <
     audioBuffer.length; i += chunkSize) {
                     const chunk =
     audioBuffer.slice(i, i + chunkSize);
                     const payload =
     chunk.toString('base64');

                     ws.send(JSON.stringify({
                       event: 'media',
                       media: { payload }
                     }));
                   }
                 }

                 if (message.isFinal) {
                   // Send mark after playback 
     completion
                   ws.send(JSON.stringify({
                     event: 'mark',
                     mark: { name:
     'playback_complete' }
                   }));
                 }
               } catch (error) {
                 console.error('Error processing 
     ElevenLabs audio:', error);
               }
             });

             elevenLabsWs.on('error', (error) =>
     {
               console.error('ElevenLabs 
     WebSocket error:', error);
             });

             elevenLabsWs.on('close', () => {
               console.log('ElevenLabs WebSocket 
     closed');
             });
           };

           connectElevenLabs();

           // Deepgram event handlers
           dgConnection.on('open', () => {
             console.log('Deepgram connection 
     opened');
           });

           dgConnection.on('transcript', async
     (data) => {
             const transcript =
     data.channel?.alternatives?.[0]?.transcript;
             if (!transcript) return;

             if (data.is_final ||
     data.speech_final) {
               transcriptBuffer += transcript + '
      ';
               console.log(`Final transcript: 
     ${transcript}`);

               // Process with Claude on final 
     transcript
               if (!isProcessing) {
                 isProcessing = true;
                 await
     processWithClaude(transcriptBuffer.trim());
                 transcriptBuffer = '';
                 isProcessing = false;
               }
             } else {
               console.log(`Interim: 
     ${transcript}`);
             }
           });

           dgConnection.on('utteranceEnd', async
     () => {
             if (transcriptBuffer.trim() &&
     !isProcessing) {
               isProcessing = true;
               await
     processWithClaude(transcriptBuffer.trim());
               transcriptBuffer = '';
               isProcessing = false;
             }
           });

           dgConnection.on('error', (error) => {
             console.error('Deepgram error:',
     error);
           });

           // Process transcript with Claude
           const processWithClaude = async
     (transcript) => {
             try {
               // Save user turn to database
               const { data: userTurn } = await
     supabase
                 .from('turns')
                 .insert([{
                   call_id: currentCall?.id,
                   role: 'user',
                   content: transcript,
                   created_at: new Date()
                 }])
                 .select()
                 .single();

               // Call Claude with tool schema
               const response = await
     anthropic.messages.create({
                 model:
     'claude-3-5-sonnet-20241022',
                 max_tokens: 1000,
                 messages: [
                   {
                     role: 'user',
                     content: `You are an AI 
     receptionist. Process this caller input and 
     respond appropriately: "${transcript}"`
                   }
                 ],
                 tools: [
                   {
                     name:
     'receptionist_response',
                     description: 'Generate a 
     structured response for the AI 
     receptionist',
                     input_schema: {
                       type: 'object',
                       properties: {
                         intent: {
                           type: 'string',
                           description: 'The 
     detected intent (e.g., appointment_request, 
     question, greeting)'
                         },
                         response_text: {
                           type: 'string',
                           description: 'The text
      response to speak to the caller'
                         },
                         escalate: {
                           type: 'boolean',
                           description: 'Whether 
     to escalate to a human agent'
                         },
                         slots: {
                           type: 'object',
                           description:
     'Extracted entities and values from the 
     input',
                           additionalProperties:
     true
                         }
                       },
                       required: ['intent',
     'response_text', 'escalate', 'slots']
                     }
                   }
                 ],
                 tool_choice: { type: 'tool',
     name: 'receptionist_response' }
               });

               let result;
               if (response.content[0].type ===
     'tool_use') {
                 result =
     response.content[0].input;
               } else {
                 // Auto-repair: create fallback 
     response if tool wasn't used
                 result = {
                   intent: 'unknown',
                   response_text: 'I understand. 
     How can I help you today?',
                   escalate: false,
                   slots: {}
                 };
               }

               // Validate and auto-repair schema
               if (!result.intent) result.intent
     = 'unknown';
               if (!result.response_text)
     result.response_text = 'How can I help 
     you?';
               if (typeof result.escalate !==
     'boolean') result.escalate = false;
               if (!result.slots || typeof
     result.slots !== 'object') result.slots =
     {};

               console.log(`Claude response: 
     ${JSON.stringify(result)}`);

               // Save assistant turn and intent
               await Promise.all([
                 supabase.from('turns').insert([{
                   call_id: currentCall?.id,
                   role: 'assistant',
                   content: result.response_text,
                   created_at: new Date()
                 }]),

     supabase.from('intents').insert([{
                   call_id: currentCall?.id,
                   intent: result.intent,
                   confidence: 1.0,
                   slots: result.slots,
                   escalate: result.escalate,
                   created_at: new Date()
                 }])
               ]);

               // Send response to ElevenLabs for
      TTS
               if (elevenLabsWs &&
     elevenLabsWs.readyState === WebSocket.OPEN)
     {
                 // Send clear command for 
     barge-in capability
                 ws.send(JSON.stringify({ event:
     'clear' }));

                 // Send text to ElevenLabs

     elevenLabsWs.send(JSON.stringify({
                   text: result.response_text,
                   try_trigger_generation: true
                 }));
               }

             } catch (error) {
               console.error('Error processing 
     with Claude:', error);

               // Fallback response
               const fallbackText = "I'm sorry, I
      didn't catch that. Could you please 
     repeat?";
               if (elevenLabsWs &&
     elevenLabsWs.readyState === WebSocket.OPEN)
     {

     elevenLabsWs.send(JSON.stringify({
                   text: fallbackText,
                   try_trigger_generation: true
                 }));
               }
             }
           };

           // Handle Twilio WebSocket messages
           ws.on('message', (data) => {
             try {
               const message = JSON.parse(data);

               switch (message.event) {
                 case 'start':
                   console.log('Twilio stream 
     started:', message.start.streamSid);
                   break;

                 case 'media':
                   // Forward µ-law audio to 
     Deepgram
                   if (dgConnection &&
     dgConnection.readyState === WebSocket.OPEN)
     {
                     const audioBuffer =
     Buffer.from(message.media.payload,
     'base64');

     dgConnection.send(audioBuffer);
                   }
                   break;

                 case 'stop':
                   console.log('Twilio stream 
     stopped');
                   break;

                 case 'mark':
                   console.log('Mark received:',
     message.mark.name);
                   break;
               }
             } catch (error) {
               console.error('Error processing 
     Twilio message:', error);
             }
           });

           // Handle WebSocket close
           ws.on('close', async () => {
             console.log(`WebSocket closed for 
     CallSid: ${callSid}`);

             // Cleanup connections
             if (dgConnection)
     dgConnection.finish();
             if (elevenLabsWs)
     elevenLabsWs.close();

             // Update call status
             if (currentCall) {
               await supabase
                 .from('calls')
                 .update({ status: 'completed',
     ended_at: new Date() })
                 .eq('id', currentCall.id);
             }
           });

           // Handle errors
           ws.on('error', (error) => {
             console.error('WebSocket error:',
     error);
           });
         });

       } catch (err) {
         fastify.log.error(err);
         process.exit(1);
       }
     };

     start();

