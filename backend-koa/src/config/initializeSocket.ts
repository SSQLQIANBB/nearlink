import { Server } from 'http';
import { Server as SocketServer } from 'socket.io';
import chalk from 'chalk';

const roomUsersMap = new Map();
export default function initializeSocket(server: Server) {
  const io = new SocketServer(server, {
    path: '/connect',
    cors: {
      origin: '*',
    },
  });

  io.on('connection', (socket) => {
    console.log('socket connect success', socket.id);

    const { query } = socket.handshake;
    const { username, roomId } = query;
    const users = roomUsersMap.get(roomId) || [];

    console.log(chalk.bold.yellow.bgBlue(username), `加入房间:`, chalk.hex('#2080f0')(roomId));

    // 加入房间
    socket.join(roomId);

    users.push({ username, userId: socket.id });
    roomUsersMap.set(roomId, users);

    io.to(roomId).emit('userList', users);

    socket.on('join', (data) => {
      console.log(data);
    });

    socket.on('ready', () => {
      socket.broadcast.emit('ready');
    });

    socket.on('offer', ({ userId, offer }) => {
      socket.to(userId).emit('offer', { userId: socket.id, offer });
    });

    socket.on('answer', ({ userId, answer: data }) => {
      socket.to(userId).emit('answer', data);
    });

    socket.on('ice', ({ userId, candidate: data }) => {
      socket.to(userId).emit('ice', data);
    });

    socket.on('toCustomCandidate', (data) => {
      socket.broadcast.emit('toCustomCandidate', data);
    });

    socket.on('toUserCandidate', (data) => {
      socket.broadcast.emit('toUserCandidate', data);
    });

    socket.on('stream', (stream) => {
      console.log('stream:', stream);
    });

    socket.on('disconnect', () => {
      const users = roomUsersMap.get(roomId) || [];

      const index = users.findIndex((u) => u.userId === socket.id);

      users.splice(index, 1);

      roomUsersMap.set(roomId, users);

      io.to(roomId).emit('userList', users);
      console.log('socket ---- disconnect');
    });
  });
}
