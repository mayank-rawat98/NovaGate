import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  planId!: string;

  @Column({ default: 0 })
  gatewayConfigVersion!: number;

  @Column({ nullable: true })
  passwordHash!: string;

  @Column({ type: 'timestamp', nullable: true })
  lastSeen!: Date;

  @Column({ nullable: true })
  resetPasswordToken!: string;

  @Column({ type: 'timestamp', nullable: true })
  resetPasswordExpires!: Date;

  @Column({ default: false })
  emailVerified!: boolean;

  @Column({ nullable: true })
  verifyToken!: string;

  @Column({ type: 'timestamp', nullable: true })
  verifyExpires!: Date;

  @Column({ type: 'text', nullable: true })
  caCertPem!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenantId!: string;

  @Column()
  keyHash!: string;

  @Column()
  label!: string;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity('pending_config_updates')
export class PendingConfigUpdate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenantId!: string;

  @Column({ type: 'jsonb' })
  config!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;
}
