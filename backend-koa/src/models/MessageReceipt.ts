import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

class MessageReceipt extends Model {
  declare userId: number;
  declare kind: 'private' | 'group';
  declare clientMessageId: string;
  declare contentHash: string;
  declare messageId: number | null;
}

MessageReceipt.init(
  {
    userId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    kind: { type: DataTypes.ENUM('private', 'group'), allowNull: false, primaryKey: true },
    clientMessageId: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
    contentHash: { type: DataTypes.STRING(64), allowNull: false },
    messageId: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize, tableName: 'message_receipts', timestamps: true },
);

export default MessageReceipt;
