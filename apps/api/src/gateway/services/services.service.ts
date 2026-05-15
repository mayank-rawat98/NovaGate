import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ServicesRepository } from './services.repository';
import { ServiceEntity } from './entities/service.entity';

@Injectable()
export class ServicesService {
  constructor(private readonly repository: ServicesRepository) {}

  async getAllServices(): Promise<ServiceEntity[]> {
    return this.repository.findAll();
  }

  async getService(id: string): Promise<ServiceEntity> {
    const service = await this.repository.findById(id);
    if (!service) {
      throw new NotFoundException(`Service with ID ${id} not found`);
    }
    return service;
  }

  async createService(data: Partial<ServiceEntity>): Promise<ServiceEntity> {
    if (data.name) {
      const existing = await this.repository.findByName(data.name);
      if (existing) {
        throw new ConflictException(
          `Service with name ${data.name} already exists`,
        );
      }
    }
    return this.repository.create(data);
  }

  async updateService(
    id: string,
    data: Partial<ServiceEntity>,
  ): Promise<ServiceEntity> {
    const service = await this.getService(id);
    const updated = await this.repository.update(id, { ...service, ...data });
    if (!updated) {
      throw new NotFoundException(
        `Service with ID ${id} not found after update`,
      );
    }
    return updated;
  }

  async deleteService(id: string): Promise<void> {
    await this.getService(id);
    await this.repository.delete(id);
  }
}
