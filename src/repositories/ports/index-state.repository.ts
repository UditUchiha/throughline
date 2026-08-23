import { IndexState } from '../../common/types/knowledge.types';

export interface IndexStateRepository {
  get(path: string): Promise<IndexState | null>;
  upsert(state: IndexState): Promise<void>;
  all(): Promise<IndexState[]>;
  delete(path: string): Promise<void>;
  setMeta(key: string, value: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
}
