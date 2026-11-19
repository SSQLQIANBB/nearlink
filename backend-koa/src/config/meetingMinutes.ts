/**
 * 会议实时记录 Socket.IO 配置（path: /meeting-minutes，不是 namespace）。
 *
 * 职责：握手认证（io.use 校验登录会话）、事件接线、二进制分片校验；
 * 会话生命周期与状态转换集中在 MeetingRecordingService。
 *
 * 客户端事件：
 * - minutes_start { }                          → ACK { ok, sessionId, audioFormat, capabilities }
 * - minutes_attach { sessionId }               → ACK { ok, status, lastAcceptedAudioIndex, acceptedSamples }
 * - minutes_pause / minutes_resume { sessionId } → ACK { ok, lastAcceptedAudioIndex }
 * - minutes_end { sessionId, lastAudioIndex }  → ACK { ok, durationSeconds, transcriptComplete }
 * - minutes_audio { sessionId, audioIndex }, ArrayBuffer → ACK { sessionId, lastAcceptedAudioIndex, acceptedSamples }
 *
 * 服务端事件：
 * - minutes_transcript { sessionId, segments }
 * - minutes_error { sessionId, error }
 *
 * 协议详见 docs/MEETING_RECORDING_PROTOCOL.md。
 */
import type { Server } from 'http';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { Server as ServerType, type Socket } from 'socket.io';
import {
  AuthenticatedSessionPayload,
  validateAuthenticatedSession,
} from '../services/loginSessionService';
import { sherpaAsrClient } from '../services/asrClient';
import {
  AUDIO_FORMAT,
  MeetingRecordingService,
} from '../services/meetingRecordingService';
import { env } from '../config/env';

const START_CAPABILITIES = Object.freeze({ transcription: true });

const attachSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
const endSchema = z
  .object({ sessionId: z.string().uuid(), lastAudioIndex: z.number().int().min(-1), tailComplete: z.boolean().default(true) })
  .strict();
const audioMetaSchema = z
  .object({ sessionId: z.string().uuid(), audioIndex: z.number().int().min(0) })
  .strict();

type AuthedSocket = Socket & { data: { user?: AuthenticatedSessionPayload } };

export const meetingRecordingService = new MeetingRecordingService({ asr: sherpaAsrClient });

export function initializeMeetingMinutes(httpServer: Server) {
  const io = new ServerType(httpServer, {
    path: '/meeting-minutes',
    // 二进制音频固定走 WebSocket transport，避免 polling 降级产生 Base64。
    transports: ['websocket'],
  });
  const service = meetingRecordingService;

  // 握手认证：token 放在 Socket.IO auth 中，连接 Promise 在认证完成后才成功。
  io.use(async (socket: AuthedSocket, next) => {
    const token = (socket.handshake.auth?.token ?? '') as string;
    if (!token) {
      next(new Error('auth_failed'));
      return;
    }
    // token 过期复用现有刷新能力；会话撤销和退出登录属于终止条件，不能无限重连。
    let expired = false;
    try {
      jwt.verify(token, env.auth.jwtSecret, { algorithms: ['HS256'] });
    } catch (error) {
      expired = (error as { name?: string })?.name === 'TokenExpiredError';
    }
    if (expired) {
      next(new Error('token_expired'));
      return;
    }
    try {
      socket.data.user = await validateAuthenticatedSession(token);
      next();
    } catch {
      next(new Error('auth_failed'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    const user = socket.data.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    service.onConnect(socket, user);

    socket.on('minutes_start', async (raw: unknown, ack: (result: unknown) => void) => {
      try {
        const parsed = z.object({ source: z.enum(['offline', 'call']).default('offline'), callId: z.string().min(1).max(128).optional() }).strict().safeParse(raw ?? {});
        if (!parsed.success || (parsed.data.source === 'call' && !parsed.data.callId)) {
          ack({ ok: false, error: 'BAD_REQUEST' }); return;
        }
        const result = await service.start(socket, user, parsed.data);
        if (result.ok === false) {
          ack({ ok: false, error: result.error });
          return;
        }
        ack({
          ok: true,
          sessionId: result.sessionId,
          audioFormat: {
            encoding: AUDIO_FORMAT.encoding,
            sampleRate: AUDIO_FORMAT.sampleRate,
            channels: AUDIO_FORMAT.channels,
          },
          capabilities: { ...START_CAPABILITIES, transcription: result.transcriptionAvailable },
          transcriptionAvailable: result.transcriptionAvailable,
        });
      } catch (error) {
        console.error('meeting_minutes_start_failed', { type: (error as Error)?.message });
        ack({ ok: false, error: 'INTERNAL' });
      }
    });

    socket.on('minutes_attach', async (raw: unknown, ack: (result: unknown) => void) => {
      const parsed = attachSchema.safeParse(raw);
      if (!parsed.success) {
        ack({ ok: false, error: 'BAD_REQUEST' });
        return;
      }
      try {
        const result = await service.attach(socket, user, parsed.data.sessionId);
        ack(result);
      } catch (error) {
        console.error('meeting_minutes_attach_failed', { type: (error as Error)?.message });
        ack({ ok: false, error: 'INTERNAL' });
      }
    });

    socket.on('minutes_pause', async (raw: unknown, ack: (result: unknown) => void) => {
      const parsed = attachSchema.safeParse(raw);
      if (!parsed.success) {
        ack({ ok: false, error: 'BAD_REQUEST' });
        return;
      }
      try { ack(await service.pause(socket, user, parsed.data.sessionId)); }
      catch (error) { console.error('meeting_pause_failed', error); ack({ ok: false, error: 'PERSIST_FAILED' }); }
    });

    socket.on('minutes_resume', async (raw: unknown, ack: (result: unknown) => void) => {
      const parsed = attachSchema.safeParse(raw);
      if (!parsed.success) {
        ack({ ok: false, error: 'BAD_REQUEST' });
        return;
      }
      try { ack(await service.resume(socket, user, parsed.data.sessionId)); }
      catch (error) { console.error('meeting_resume_failed', error); ack({ ok: false, error: 'PERSIST_FAILED' }); }
    });

    socket.on('minutes_end', async (raw: unknown, ack: (result: unknown) => void) => {
      const parsed = endSchema.safeParse(raw);
      if (!parsed.success) {
        ack({ ok: false, error: 'BAD_REQUEST' });
        return;
      }
      try {
        ack(await service.end(socket, user, parsed.data.sessionId, parsed.data.lastAudioIndex, parsed.data.tailComplete));
      } catch (error) {
        console.error('meeting_minutes_end_failed', { type: (error as Error)?.message });
        ack({ ok: false, error: 'INTERNAL' });
      }
    });

    // 二进制分片：socket.io 将 ArrayBuffer 转为 Buffer。
    socket.on(
      'minutes_audio',
      async (meta: unknown, pcm: Buffer, ack: (result: unknown) => void) => {
        const parsed = audioMetaSchema.safeParse(meta);
        if (!parsed.success || !Buffer.isBuffer(pcm)) {
          ack({ error: 'BAD_REQUEST' });
          return;
        }
        try {
          const result = await service.onAudio(socket, user, parsed.data.sessionId, parsed.data.audioIndex, pcm);
          ack(result);
        } catch (error) {
          console.error('meeting_minutes_audio_failed', { type: (error as Error)?.message });
          ack({ error: 'INTERNAL' });
        }
      },
    );

    socket.on('disconnect', () => {
      service.onDisconnect(socket);
    });
  });

  return {
    async close(): Promise<void> {
      await service.close();
      io.close();
    },
    /** 启动后调用：把上次进程遗留的活动录音标为异常终止。 */
    markOrphanedSessions: () => service.markOrphanedSessions(),
  };
}
