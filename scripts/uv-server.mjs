import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';

const PORT = Number(process.env.UV_SERVER_PORT || 3100);
const BLENDER_EXE = process.env.BLENDER_EXE || 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe';
const SCRIPT_PATH = path.resolve('scripts/blender-unwrap.py');
const NATIVE_WRAP_EXE = process.env.FINGERPRINT_WRAP_EXE || path.resolve('native/bin/fingerprint_wrap.exe');
const METHODS = new Set(['native-angle-based', 'native-conformal', 'native-minimum-stretch']);

function sendCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name');
}

function runBlender(inputPath, outputPath, method) {
  return new Promise((resolve, reject) => {
    const args = [
      '--background',
      '--factory-startup',
      '--python', SCRIPT_PATH,
      '--',
      '--input', inputPath,
      '--output', outputPath,
      '--method', method,
    ];

    const child = spawn(BLENDER_EXE, args, {
      windowsHide: true,
      env: {
        ...process.env,
        EXPO_NATIVE_UV_JOB: JSON.stringify({
          input: inputPath,
          output: outputPath,
          method,
        }),
      },
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Blender exited with code ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function numberArray(value, name, maxLength) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${name} is too large (${value.length}).`);
  }
  return value.map((n, i) => {
    const v = Number(n);
    if (!Number.isFinite(v)) throw new Error(`${name}[${i}] is not finite.`);
    return v;
  });
}

function buildWrapInput(body) {
  const vertices = numberArray(body.vertices, 'vertices', 1500000);
  const indices = numberArray(body.indices, 'indices', 3000000).map((n) => Math.trunc(n));
  const decals = Array.isArray(body.decals) ? body.decals : [];

  if (vertices.length % 3 !== 0) throw new Error('vertices length must be divisible by 3.');
  if (indices.length % 3 !== 0) throw new Error('indices length must be divisible by 3.');
  if (decals.length > 64) throw new Error('Too many decals.');

  const lines = [
    `${vertices.length / 3} ${indices.length / 3} ${decals.length}`,
  ];

  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(`${vertices[i]} ${vertices[i + 1]} ${vertices[i + 2]}`);
  }

  for (let i = 0; i < indices.length; i += 3) {
    lines.push(`${indices[i]} ${indices[i + 1]} ${indices[i + 2]}`);
  }

  decals.forEach((decal, index) => {
    const position = numberArray(decal.position, `decals[${index}].position`, 3);
    if (position.length !== 3) throw new Error(`decals[${index}].position must have 3 values.`);
    const normal = Array.isArray(decal.normal) ? numberArray(decal.normal, `decals[${index}].normal`, 3) : [0, 0, 0];
    if (normal.length !== 3) throw new Error(`decals[${index}].normal must have 3 values.`);
    const size = numberArray(decal.size, `decals[${index}].size`, 3);
    if (size.length < 2) throw new Error(`decals[${index}].size must have at least 2 values.`);
    const decalIndex = Number.isInteger(decal.index) ? decal.index : index;
    const faceIndex = Number.isInteger(decal.faceIndex) ? decal.faceIndex : -1;
    const rotation = Number.isFinite(Number(decal.rotation)) ? Number(decal.rotation) : 0;
    lines.push(`${decalIndex} ${position[0]} ${position[1]} ${position[2]} ${normal[0]} ${normal[1]} ${normal[2]} ${faceIndex} ${size[0]} ${size[1]} ${rotation}`);
  });

  return lines.join('\n') + '\n';
}

function runNativeWrap(inputText) {
  return new Promise((resolve, reject) => {
    const child = spawn(NATIVE_WRAP_EXE, [], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`fingerprint_wrap exited with code ${code}\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`fingerprint_wrap returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout.slice(0, 1000)}`));
      }
    });

    child.stdin.end(inputText);
  });
}

function safeExtension(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  return ext === '.stl' ? '.stl' : '.obj';
}

const app = express();

app.use((req, res, next) => {
  sendCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, blender: BLENDER_EXE, nativeWrap: NATIVE_WRAP_EXE });
});

app.post('/wrap-decals', express.json({ limit: '250mb' }), async (req, res) => {
  try {
    const inputText = buildWrapInput(req.body || {});
    const started = Date.now();
    const result = await runNativeWrap(inputText);
    res.json({
      ok: true,
      ms: Date.now() - started,
      ...result,
    });
  } catch (error) {
    console.error('[NativeWrap]', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/unwrap', express.raw({ type: '*/*', limit: '250mb' }), async (req, res) => {
  const method = String(req.query.method || 'native-minimum-stretch');
  if (!METHODS.has(method)) {
    res.status(400).json({ error: `Unsupported native UV method: ${method}` });
    return;
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'Empty upload body.' });
    return;
  }

  const id = crypto.randomUUID();
  const originalName = decodeURIComponent(String(req.query.filename || req.header('X-File-Name') || 'model.obj'));
  const tempDir = path.join(os.tmpdir(), 'expo-native-uv', id);
  const inputPath = path.join(tempDir, `input${safeExtension(originalName)}`);
  const outputPath = path.join(tempDir, 'unwrapped.obj');

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(inputPath, req.body);
    const result = await runBlender(inputPath, outputPath, method);
    const objText = await fs.readFile(outputPath, 'utf8');
    res.type('text/plain').setHeader('X-Native-UV-Log', Buffer.from(result.stdout).toString('base64'));
    res.send(objText);
  } catch (error) {
    console.error('[NativeUV]', error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[NativeUV] server listening on http://127.0.0.1:${PORT}`);
  console.log(`[NativeUV] using Blender: ${BLENDER_EXE}`);
});
