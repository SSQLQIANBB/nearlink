import { DataTypes, Model } from 'sequelize';
import sequelize from '../config/database';

class UserEmail extends Model {
  declare userId: number;
  declare email: string;
  declare verifiedAt: Date;
}

UserEmail.init(
  {
    userId: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
    email: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    verifiedAt: { type: DataTypes.DATE, allowNull: false },
  },
  {
    sequelize,
    tableName: 'user_emails',
    timestamps: false,
  },
);

export default UserEmail;
