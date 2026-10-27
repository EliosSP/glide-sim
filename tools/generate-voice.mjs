// Generates the demo voice-over with ElevenLabs: one mp3 per line of src/modes/narration.json
// into public/voice/<id>.mp3. Your API key stays on your machine (environment variable).
//
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... npm run voice            # missing files only
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... npm run voice -- --force # regenerate all
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... npm run voice -- 07_steer 12_done
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const key = process.env.ELEVENLABS_API_KEY;
const voice = process.env.ELEVENLABS_VOICE_ID;
if (!key || !voice) {
  console.error('Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID (see README, "Voce della demo").');
  process.exit(1);
}
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));

const lines = Object.entries(JSON.parse(readFileSync(new URL('../src/modes/narration.json', import.meta.url), 'utf8')));
const outDir = new URL('../public/voice/', import.meta.url);
mkdirSync(outDir, { recursive: true });

// Calm keynote narrator: steady, unhurried, little exaggeration
const settings = { stability: 0.6, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true, speed: 0.95 };

for (const [i, [id, text]] of lines.entries()) {
  if (only.length && !only.includes(id)) continue;
  const file = new URL(`${id}.mp3`, outDir);
  if (existsSync(file) && !force && !only.length) {
    console.log(`= ${id} (exists)`);
    continue;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: settings,
      // Neighbouring lines keep the intonation continuous across clips
      previous_text: lines[i - 1]?.[1],
      next_text: lines[i + 1]?.[1],
    }),
  });
  if (!res.ok) {
    console.error(`✗ ${id}: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`✓ ${id}`);
}
