import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { verifyControllerBinding } from '../../../src/services/remoteCredentials';
const v = JSON.parse(readFileSync(path.resolve(process.cwd(), '../fixtures/remote-controller-binding-v1.json'), 'utf8'));
const claims = JSON.parse(Buffer.from(v.proof.payload, 'base64url').toString());
describe('跨语言主控设备证明', () => {
  it('验证与 Rust 共用的设备签名，拒绝撤销设备及另一连接', () => {
    expect(() => verifyControllerBinding(v.proof, v.device, v.expected.controller, claims.challenge, v.now, v.now)).not.toThrow();
    expect(() => verifyControllerBinding(v.proof, { ...v.device, revokedAt: new Date() }, v.expected.controller, claims.challenge, v.now, v.now)).toThrow();
    expect(() => verifyControllerBinding(v.proof, v.device, { ...v.expected.controller, connectionId: 'other' }, claims.challenge, v.now, v.now)).toThrow();
  });
});
