import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { generateKeyPairSync, createPublicKey, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import path from 'node:path';

// Only prepares the local development backend. Private material stays server-side.
export async function prepareDevelopmentSigning(repository) {
  const envFile = path.join(repository, 'backend-koa/.env.local');
  let text;
  try { text = await readFile(envFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const config = parseEnv(text);
  if (config.NODE_ENV !== 'development') return null;
  const names = ['REMOTE_CONTROL_SIGNING_KEY_ID', 'REMOTE_CONTROL_SIGNING_PRIVATE_KEY',
    'REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE', 'REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER'];
  if (names.every((name) => !config[name])) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const now = Date.now();
    Object.assign(config, {
      REMOTE_CONTROL_SIGNING_KEY_ID: `local-dev-${randomUUID()}`,
      REMOTE_CONTROL_SIGNING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE: String(now - 60000),
      REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER: String(now + 365 * 86400000),
    });
    text = text.split(/\r?\n/).filter((line) => !names.some((name) => line.startsWith(`${name}=`))).join('\n');
    await writeFile(envFile, `${text.trimEnd()}\n\n${names.map((name) => `${name}="${config[name]}"`).join('\n')}\n`, { mode: 0o600 });
    console.log('[远控] 已准备本地开发签名配置。请重启本地后端，使新配置生效。');
  }
  if (names.some((name) => !config[name])) throw new Error('本地远控签名配置不完整，请补齐 backend-koa/.env.local 中的签名配置。');
  const key = createPublicKey(config.REMOTE_CONTROL_SIGNING_PRIVATE_KEY);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('本地远控签名必须使用 Ed25519。');
  const notBefore = Number(config.REMOTE_CONTROL_SIGNING_KEY_NOT_BEFORE);
  const notAfter = Number(config.REMOTE_CONTROL_SIGNING_KEY_NOT_AFTER);
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter) || Date.now() < notBefore || Date.now() >= notAfter)
    throw new Error('本地远控签名有效期不正确，请更新开发签名配置。');
  const directory = path.join(repository, 'dist/remote-control-dev');
  await mkdir(directory, { recursive: true });
  const publicFile = path.join(directory, 'development-trusted-key.json');
  await writeFile(publicFile, JSON.stringify({ keyId: config.REMOTE_CONTROL_SIGNING_KEY_ID,
    publicKey: key.export({ format: 'jwk' }).x, notBefore, notAfter }));
  return publicFile;
}
