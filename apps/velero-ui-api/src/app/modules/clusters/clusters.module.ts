import { Module } from '@nestjs/common';
import { ClustersController } from './clusters.controller';

@Module({ controllers: [ClustersController] })
export class ClustersModule {}
