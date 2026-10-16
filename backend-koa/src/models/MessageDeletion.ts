import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

// 删除只影响当前账号；原消息仍供其他参与者和已发送的引用使用。
class MessageDeletion extends Model {
  declare userId: number;
  declare kind: 'private' | 'group';
  declare messageId: number;
}
MessageDeletion.init(
  {
    userId: { type: DataTypes.INTEGER, primaryKey: true },
    kind: { type: DataTypes.STRING(10), primaryKey: true },
    messageId: { type: DataTypes.INTEGER, primaryKey: true },
  },
  { sequelize, tableName: 'message_deletions', timestamps: false },
);
export default MessageDeletion;
