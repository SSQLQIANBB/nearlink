export class MediaRoomRegistry {
  private readonly rooms = new Map<string, Map<string, number>>();

  join(channelId: string, socketId: string, userId: number) {
    const room = this.rooms.get(channelId) ?? new Map<string, number>();
    const alreadyJoined = room.has(socketId);
    room.set(socketId, userId);
    this.rooms.set(channelId, room);
    return {
      alreadyJoined,
      userIds: this.getUserIds(channelId),
    };
  }

  leave(channelId: string, socketId: string) {
    const room = this.rooms.get(channelId);
    if (!room?.delete(socketId)) return false;
    if (room.size === 0) this.rooms.delete(channelId);
    return true;
  }

  leaveSocket(socketId: string) {
    const changedChannels: string[] = [];
    for (const channelId of [...this.rooms.keys()].sort()) {
      if (this.leave(channelId, socketId)) {
        changedChannels.push(channelId);
      }
    }
    return changedChannels;
  }

  getSocketIds(channelId: string) {
    return [...(this.rooms.get(channelId)?.keys() ?? [])];
  }

  getUserIds(channelId: string) {
    return [...new Set(this.rooms.get(channelId)?.values() ?? [])].sort(
      (left, right) => left - right,
    );
  }

  clear(channelId: string) {
    this.rooms.delete(channelId);
  }
}
