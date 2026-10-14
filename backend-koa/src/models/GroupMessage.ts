import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

export interface GroupMessageAttributes {
  id?: number;
  groupId: number;
  userId: number;
  message: string;
  messageType: 'text' | 'image' | 'file' | 'system';
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

interface GroupMessageCreationAttributes
  extends Optional<
    GroupMessageAttributes,
    'id' | 'messageType' | 'fileUrl' | 'fileName' | 'fileSize'
  > {}

class GroupMessage
  extends Model<GroupMessageAttributes, GroupMessageCreationAttributes>
  implements GroupMessageAttributes
{
  declare id?: number;
  declare groupId: number;
  declare userId: number;
  declare message: string;
  declare messageType: 'text' | 'image' | 'file' | 'system';
  declare fileUrl?: string;
  declare fileName?: string;
  declare fileSize?: number;
  declare readonly createdAt?: Date;
  declare readonly updatedAt?: Date;
}

GroupMessage.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '群组ID',
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '发送者用户ID',
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '消息内容',
    },
    messageType: {
      type: DataTypes.ENUM('text', 'image', 'file', 'system'),
      defaultValue: 'text',
      comment: '消息类型',
    },
    fileUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: '文件URL',
    },
    fileName: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: '文件名',
    },
    fileSize: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '文件大小(字节)',
    },
  },
  {
    sequelize,
    tableName: 'group_messages',
    timestamps: true,
    indexes: [
      {
        fields: ['groupId'],
      },
      {
        fields: ['userId'],
      },
      {
        fields: ['createdAt'],
      },
    ],
  },
);

export default GroupMessage;
