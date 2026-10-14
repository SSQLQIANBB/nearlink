import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database';

export interface FileAttributes {
  id?: number;
  userId: number;
  groupId?: number;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  filePath: string;
  fileUrl: string;
  downloadCount: number;
  createdAt?: Date;
  updatedAt?: Date;
}

interface FileCreationAttributes
  extends Optional<FileAttributes, 'id' | 'groupId' | 'downloadCount'> {}

class File extends Model<FileAttributes, FileCreationAttributes> implements FileAttributes {
  declare id?: number;
  declare userId: number;
  declare groupId?: number;
  declare fileName: string;
  declare originalName: string;
  declare fileSize: number;
  declare mimeType: string;
  declare filePath: string;
  declare fileUrl: string;
  declare downloadCount: number;
  declare readonly createdAt?: Date;
  declare readonly updatedAt?: Date;
}

File.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '上传者用户ID',
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '所属群组ID（可选）',
    },
    fileName: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: '存储的文件名',
    },
    originalName: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: '原始文件名',
    },
    fileSize: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '文件大小(字节)',
    },
    mimeType: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'MIME类型',
    },
    filePath: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: '七牛对象 key；迁移前记录为本地文件路径',
    },
    fileUrl: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: '稳定存储引用；迁移前记录为 /uploads URL',
    },
    downloadCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: '下载次数',
    },
  },
  {
    sequelize,
    tableName: 'files',
    timestamps: true,
    indexes: [
      {
        fields: ['userId'],
      },
      {
        fields: ['groupId'],
      },
      {
        fields: ['createdAt'],
      },
    ],
  },
);

export default File;
