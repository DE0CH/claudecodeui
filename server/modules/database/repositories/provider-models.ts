import { all, get, run, transaction } from '@/modules/database/connection.js';
import type {
  CustomProviderModelEffort,
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
} from '@/shared/types.js';

type CustomProviderModelRow = {
  id: number;
  provider: LLMProvider;
  model_id: string;
  model_name: string;
  sort_order: number;
  effort_values: string | null;
  effort_default: string | null;
};

const CUSTOM_PROVIDER_MODEL_COLUMNS = `
  id, provider, model_id, model_name, sort_order, effort_values, effort_default
`;

/**
 * Decodes the stored effort columns. Anything that is not a non-empty JSON
 * array of strings reads back as "no metadata" rather than failing the whole
 * catalog, so one hand-edited row cannot break every model picker.
 */
const readStoredEffort = (row: CustomProviderModelRow): CustomProviderModelEffort | null => {
  if (!row.effort_values) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.effort_values);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }
  const values = parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (values.length === 0) {
    return null;
  }

  return row.effort_default && values.includes(row.effort_default)
    ? { values, default: row.effort_default }
    : { values };
};

/** Encodes effort metadata into the two nullable columns; no levels means NULL for both. */
const toStoredEffortColumns = (
  effort: CustomProviderModelEffort | null | undefined,
): { values: string | null; defaultValue: string | null } => {
  if (!effort || effort.values.length === 0) {
    return { values: null, defaultValue: null };
  }

  return {
    values: JSON.stringify(effort.values),
    defaultValue: effort.default ?? null,
  };
};

const toCustomProviderModelRecord = (
  row: CustomProviderModelRow,
): CustomProviderModelRecord => ({
  recordId: row.id,
  provider: row.provider,
  modelId: row.model_id,
  model: row.model_name,
  sortOrder: row.sort_order,
  effort: readStoredEffort(row),
});

const readCustomProviderModelRow = async (
  provider: LLMProvider,
  recordId: number,
): Promise<CustomProviderModelRow | null> => {
  const row = (await get(`
    SELECT ${CUSTOM_PROVIDER_MODEL_COLUMNS}
    FROM provider_models
    WHERE provider = ? AND id = ?
  `, [provider, recordId])) as CustomProviderModelRow | undefined;

  return row ?? null;
};

/**
 * Custom provider-model persistence API consumed by the Providers module.
 *
 * Every row in this repository is user-created. Predefined models are owned by
 * provider adapters and never enter this table. Model-id changes are propagated
 * to stored sessions, while deletion replaces affected session selections with
 * the predefined default supplied by the Providers service.
 */
export const providerModelsDb = {
  async listCustomProviderModels(provider: LLMProvider): Promise<CustomProviderModelRecord[]> {
    const rows = (await all(`
      SELECT ${CUSTOM_PROVIDER_MODEL_COLUMNS}
      FROM provider_models
      WHERE provider = ?
      ORDER BY sort_order ASC, lower(model_name) ASC, id ASC
    `, [provider])) as CustomProviderModelRow[];

    return rows.map(toCustomProviderModelRecord);
  },

  async getCustomProviderModel(
    provider: LLMProvider,
    recordId: number,
  ): Promise<CustomProviderModelRecord | null> {
    const row = await readCustomProviderModelRow(provider, recordId);
    return row ? toCustomProviderModelRecord(row) : null;
  },

  async findCustomProviderModelByModelId(
    provider: LLMProvider,
    modelId: string,
  ): Promise<CustomProviderModelRecord | null> {
    const row = (await get(`
      SELECT ${CUSTOM_PROVIDER_MODEL_COLUMNS}
      FROM provider_models
      WHERE provider = ? AND model_id = ?
    `, [provider, modelId])) as CustomProviderModelRow | undefined;

    return row ? toCustomProviderModelRecord(row) : null;
  },

  async createCustomProviderModel(
    provider: LLMProvider,
    input: CustomProviderModelInput,
  ): Promise<CustomProviderModelRecord> {
    const nextOrder = (await get(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
      FROM provider_models
      WHERE provider = ?
    `, [provider])) as { next_order: number };

    const effort = toStoredEffortColumns(input.effort);
    const result = (await run(`
      INSERT INTO provider_models (
        provider, model_id, model_name, sort_order, effort_values, effort_default
      )
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [provider,
      input.id,
      input.model,
      nextOrder.next_order,
      effort.values,
      effort.defaultValue,]));

    const row = await readCustomProviderModelRow(provider, Number(result.lastInsertRowid));
    if (!row) {
      throw new Error('Created provider model could not be read back.');
    }

    return toCustomProviderModelRecord(row);
  },

  async updateCustomProviderModel(
    provider: LLMProvider,
    recordId: number,
    input: CustomProviderModelInput,
  ): Promise<CustomProviderModelRecord | null> {
    const update = async () => await transaction(async () => {
      const previous = await readCustomProviderModelRow(provider, recordId);
      if (!previous) {
        return null;
      }

      (await run(`
        UPDATE provider_models
        SET model_id = ?, model_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND id = ?
      `, [input.id, input.model, provider, recordId]));

      // An omitted `effort` keeps the stored levels so clients that only edit
      // the name or id cannot wipe them; `null` explicitly clears them.
      if (input.effort !== undefined) {
        const effort = toStoredEffortColumns(input.effort);
        (await run(`
          UPDATE provider_models
          SET effort_values = ?, effort_default = ?
          WHERE provider = ? AND id = ?
        `, [effort.values, effort.defaultValue, provider, recordId]));
      }

      if (previous.model_id !== input.id) {
        (await run(`
          UPDATE sessions
          SET model = ?, updated_at = CURRENT_TIMESTAMP
          WHERE provider = ? AND model = ?
        `, [input.id, provider, previous.model_id]));
      }

      return readCustomProviderModelRow(provider, recordId);
    });

    const row = await update();
    return row ? toCustomProviderModelRecord(row) : null;
  },

  async deleteCustomProviderModel(
    provider: LLMProvider,
    recordId: number,
    fallbackModelId: string,
  ): Promise<CustomProviderModelRecord | null> {
    const remove = async () => await transaction(async () => {
      const row = await readCustomProviderModelRow(provider, recordId);
      if (!row) {
        return null;
      }

      // The effort is cleared alongside the model because it was chosen for the
      // deleted model; replaced sessions resume on the fallback model's default.
      (await run(`
        UPDATE sessions
        SET model = ?, effort = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND model = ?
      `, [fallbackModelId, provider, row.model_id]));

      (await run(`
        DELETE FROM provider_models
        WHERE provider = ? AND id = ?
      `, [provider, recordId]));

      return row;
    });

    const row = await remove();
    return row ? toCustomProviderModelRecord(row) : null;
  },
};
