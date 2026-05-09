import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceEntity } from './entities/service.entity';

@Injectable()
export class ServicesRepository {
  constructor(
    @InjectRepository(ServiceEntity)
    private readonly repository: Repository<ServiceEntity>,
  ) {}

  async findAll(): Promise<ServiceEntity[]> {
    return this.repository.find();
  }

  async findById(id: string): Promise<ServiceEntity | null> {
    return this.repository.findOne({ where: { id } });
  }

  async findByName(name: string): Promise<ServiceEntity | null> {
    return this.repository.findOne({ where: { name } });
  }

  async create(service: Partial<ServiceEntity>): Promise<ServiceEntity> {
    const newService = this.repository.create(service);
    return this.repository.save(newService);
  }

  async update(
    id: string,
    service: Partial<ServiceEntity>,
  ): Promise<ServiceEntity | null> {
    await this.repository.update(id, service);
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.repository.delete(id);
  }
}
