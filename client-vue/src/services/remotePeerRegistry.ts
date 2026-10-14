import { markRaw, reactive } from 'vue';

export type RemoteMember = {
  id: number;
  socketId: string;
  username: string;
  nickname?: string;
  avatar?: string;
};

export type PeerConnectionLike = {
  close(): void;
};

export type RemotePeer = RemoteMember & {
  connection: PeerConnectionLike;
  stream?: MediaStream;
  video?: HTMLVideoElement;
};

export class RemotePeerRegistry {
  private readonly peers = reactive(new Map<number, RemotePeer>());

  constructor(private readonly createConnection: (member: RemoteMember) => PeerConnectionLike) {}

  upsert(member: RemoteMember) {
    const existing = this.peers.get(member.id);
    if (existing?.socketId === member.socketId) {
      Object.assign(existing, member);
      return existing;
    }

    // userId 是窗口主键；重连只替换 socket 和连接，不新增第二个窗口。
    existing?.connection.close();
    const peer: RemotePeer = {
      ...member,
      connection: markRaw(this.createConnection(member)),
      stream: existing?.stream,
      video: existing?.video,
    };
    this.peers.set(member.id, peer);
    this.bindCurrentStream(peer);
    return peer;
  }

  get(userId: number) {
    return this.peers.get(userId);
  }

  values() {
    return Array.from(this.peers.values());
  }

  setStream(userId: number, stream: MediaStream) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.stream = markRaw(stream);
    this.bindCurrentStream(peer);
  }

  bindVideo(userId: number, video?: HTMLVideoElement | null) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.video = video ? markRaw(video) : undefined;
    this.bindCurrentStream(peer);
  }

  remove(userId: number, socketId?: string) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    if (socketId && peer.socketId !== socketId) return;
    peer.connection.close();
    if (peer.video) peer.video.srcObject = null;
    this.peers.delete(userId);
  }

  clear() {
    for (const userId of [...this.peers.keys()]) {
      this.remove(userId);
    }
  }

  private bindCurrentStream(peer: RemotePeer) {
    if (!peer.video || !peer.stream) return;
    if (peer.video.srcObject !== peer.stream) {
      peer.video.srcObject = peer.stream;
    }
    void peer.video.play().catch(() => {
      // 浏览器可能要求用户交互后才允许播放远端音频，保留画面绑定等待用户操作。
    });
  }
}
