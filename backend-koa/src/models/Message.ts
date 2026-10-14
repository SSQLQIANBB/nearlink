import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

export interface MessageAttributes {
  id?: number;
  fromUserId: number;
  toUserId: number;
  message: string;
  isRead: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface MessageCreationAttributes extends Optional<MessageAttributes, 'id' | 'isRead'> {}

class Message
  extends Model<MessageAttributes, MessageCreationAttributes>
  implements MessageAttributes
{
  declare id?: number;
  declare fromUserId: number;
  declare toUserId: number;
  declare message: string;
  declare isRead: boolean;
  declare readonly createdAt?: Date;
  declare readonly updatedAt?: Date;
}

Message.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    fromUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '发送者用户ID',
    },
    toUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '接收者用户ID',
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '消息内容',
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: '是否已读',
    },
  },
  {
    sequelize,
    tableName: 'messages',
    timestamps: true,
    indexes: [
      {
        fields: ['fromUserId', 'toUserId', 'createdAt'],
      },
      {
        fields: ['toUserId', 'isRead', 'createdAt'],
      },
    ],
  },
);

export default Message;
