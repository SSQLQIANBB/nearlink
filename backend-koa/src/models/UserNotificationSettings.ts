import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

// 独立表由现有 sync 创建，生产环境无需对 users 开启 alter。
class UserNotificationSettings extends Model {}

UserNotificationSettings.init(
  {
    userId: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
    desktopEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    messagePreview: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyPrivateMessage: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyGroupMessage: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyCall: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyInvitation: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    messageEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    callEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    messageTone: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'default' },
    callTone: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'default' },
  },
  { sequelize, tableName: 'user_notification_settings', timestamps: false },
);

export default UserNotificationSettings;
