import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  email: string;

  @Column()
  planId: string;

  @Column({ default: 0 })
  gatewayConfigVersion: number;

  @Column({ nullable: true })
  passwordHash: string;

  @Column({ type: 'timestamp', nullable: true })
  lastSeen: Date;

  @Column({ nullable: true })
  resetPasswordToken: string;

  @Column({ type: 'timestamp', nullable: true })
  resetPasswordExpires: Date;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  keyHash: string; // SHA-256

  @Column()
  label: string;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('pending_config_updates')
export class PendingConfigUpdate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ type: 'jsonb' })
  config: any;

  @CreateDateColumn()
  createdAt: Date;
}
