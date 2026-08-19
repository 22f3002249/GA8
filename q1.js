import crypto from 'node:crypto';

// Precomputed CRC32C Lookup Table (Polynomial 0x82F63B78)
const CRC32C_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32C_TABLE[i] = c;
}

function computeCrc32cHex(str) {
  const buffer = new TextEncoder().encode(str);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32C_TABLE[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8);
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

function utf8Compare(a, b) {
  if (a === b) return 0;
  const enc = new TextEncoder();
  const bytesA = enc.encode(a);
  const bytesB = enc.encode(b);
  const minLen = Math.min(bytesA.length, bytesB.length);

  for (let i = 0; i < minLen; i++) {
    if (bytesA[i] !== bytesB[i]) {
      return bytesA[i] - bytesB[i];
    }
  }
  return bytesA.length - bytesB.length;
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

function parseAndNormalizeTimestamp(str) {
  if (typeof str !== 'string') return null;
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return null;

  const [, yStr, mStr, dStr, hStr, minStr, sStr, msStr, tzStr, signStr, tzHStr, tzMinStr] = match;

  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10);
  const day = parseInt(dStr, 10);
  const hour = parseInt(hStr, 10);
  const minute = parseInt(minStr, 10);
  const second = parseInt(sStr, 10);

  if (month < 1 || month > 12) return null;

  const daysInMonth = [0, 31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month]) return null;

  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;

  let ms = 0;
  if (msStr) {
    ms = parseInt(msStr.padEnd(3, '0'), 10);
  }

  let offsetMinutes = 0;
  if (tzStr !== 'Z') {
    const tzH = parseInt(tzHStr, 10);
    const tzMin = parseInt(tzMinStr, 10);
    if (tzH > 14) return null;
    if (tzH === 14 && tzMin !== 0) return null;
    if (tzMin > 59) return null;

    offsetMinutes = tzH * 60 + tzMin;
    if (signStr === '-') offsetMinutes = -offsetMinutes;
  }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - (offsetMinutes * 60 * 1000);
  const date = new Date(utcMs);

  if (isNaN(date.getTime())) return null;

  return date.toISOString();
}

function canonicalizeText(str) {
  return str.normalize('NFKC')
            .toLowerCase()
            .replace(/\s+/gu, ' ')
            .trim();
}

function getWordSet(text) {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (!words) return new Set();
  return new Set(words);
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

export async function handleBuildCorpus(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { policy, objects } = body;

  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!Array.isArray(objects)) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Policy validation
  let isPolicyValid = true;
  let minTimeNorm = null;
  let maxTimeNorm = null;
  let threshold = null;

  const { minTime, maxTime, contaminationThreshold } = policy;

  if (typeof contaminationThreshold !== "number" || !Number.isFinite(contaminationThreshold) || contaminationThreshold < 0 || contaminationThreshold > 1) {
    isPolicyValid = false;
  } else {
    threshold = contaminationThreshold;
  }

  minTimeNorm = parseAndNormalizeTimestamp(minTime);
  maxTimeNorm = parseAndNormalizeTimestamp(maxTime);

  if (!minTimeNorm || !maxTimeNorm) {
    isPolicyValid = false;
  } else if (minTimeNorm > maxTimeNorm) {
    isPolicyValid = false;
  }

  // Object processing
  const rejectedObjects = [];
  const lineage = [];
  const validObjects = [];

  for (const obj of objects) {
    const reasonCodes = [];
    let uriVal = null;

    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      // 1. URI validation
      if (typeof obj.uri === "string") {
        uriVal = obj.uri;
        if (!/^gs:\/\/[^\/]+\/.+$/.test(obj.uri)) {
          reasonCodes.push("URI_INVALID");
        }
      } else {
        uriVal = null;
        reasonCodes.push("URI_INVALID");
      }

      // 2. Generation validation
      const genSupplied = typeof obj.generation === "string";
      const fgenSupplied = typeof obj.fetchedGeneration === "string";

      const genValid = genSupplied && /^\d+$/.test(obj.generation);
      const fgenValid = fgenSupplied && /^\d+$/.test(obj.fetchedGeneration);

      if (!genValid || !fgenValid) {
        reasonCodes.push("GENERATION_INVALID");
      }

      if (genSupplied && fgenSupplied && obj.generation !== obj.fetchedGeneration) {
        reasonCodes.push("GENERATION_MISMATCH");
      }

      // 3. CRC32C validation
      const crcSyntaxValid = typeof obj.crc32c === "string" && /^[0-9a-f]{8}$/.test(obj.crc32c);
      if (!crcSyntaxValid) {
        reasonCodes.push("CRC32C_INVALID");
      } else if (typeof obj.content === "string") {
        const computedCrc = computeCrc32cHex(obj.content);
        if (computedCrc !== obj.crc32c) {
          reasonCodes.push("CRC32C_MISMATCH");
        }
      }

      // 4. Schema ID validation
      if (obj.schemaId !== "training-v1") {
        reasonCodes.push("SCHEMA_INVALID");
      }

      // 5. Content & JSONL validation
      if (typeof obj.content !== "string") {
        reasonCodes.push("SCHEMA_INVALID");
      } else {
        const lines = obj.content.split(/\r?\n/).filter(line => line.trim() !== "");
        if (lines.length === 0) {
          reasonCodes.push("SCHEMA_INVALID");
        } else {
          let jsonlFailed = false;
          let schemaFailed = false;
          const parsedRows = [];

          for (const line of lines) {
            let parsedRow;
            try {
              parsedRow = JSON.parse(line);
            } catch (e) {
              jsonlFailed = true;
              continue;
            }

            if (!parsedRow || typeof parsedRow !== "object" || Array.isArray(parsedRow)) {
              schemaFailed = true;
              continue;
            }

            const keys = Object.keys(parsedRow);
            if (keys.length !== 5 || !keys.includes("id") || !keys.includes("entity") || !keys.includes("eventTime") || !keys.includes("revision") || !keys.includes("text")) {
              schemaFailed = true;
              continue;
            }

            const { id, entity, eventTime, revision, text } = parsedRow;

            if (typeof id !== "string" || typeof entity !== "string" || typeof eventTime !== "string" || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || typeof text !== "string") {
              schemaFailed = true;
              continue;
            }

            const eventTimeNorm = parseAndNormalizeTimestamp(eventTime);
            if (!eventTimeNorm) {
              schemaFailed = true;
              continue;
            }

            parsedRows.push({
              id,
              entity,
              eventTime,
              eventTimeNorm,
              revision,
              text
            });
          }

          if (jsonlFailed) {
            reasonCodes.push("JSONL_INVALID");
          }
          if (schemaFailed) {
            reasonCodes.push("SCHEMA_INVALID");
          }

          if (!jsonlFailed && !schemaFailed) {
            obj._parsedRows = parsedRows;
          }
        }
      }
    } else {
      uriVal = null;
      reasonCodes.push("CRC32C_INVALID");
      reasonCodes.push("GENERATION_INVALID");
      reasonCodes.push("SCHEMA_INVALID");
      reasonCodes.push("URI_INVALID");
    }

    const uniqueCodes = Array.from(new Set(reasonCodes)).sort(utf8Compare);

    if (uniqueCodes.length > 0) {
      rejectedObjects.push({
        uri: uriVal,
        reasonCodes: uniqueCodes
      });
    } else {
      lineage.push({
        uri: obj.uri,
        generation: obj.generation,
        crc32c: obj.crc32c,
        schemaId: obj.schemaId
      });
      validObjects.push(obj);
    }
  }

  // Canonicalization & Row Extraction
  const allRows = [];
  for (const obj of validObjects) {
    for (const r of obj._parsedRows) {
      const canonicalEntity = canonicalizeText(r.entity);
      const canonicalText = canonicalizeText(r.text);

      allRows.push({
        id: r.id,
        entity: canonicalEntity,
        eventTime: r.eventTimeNorm,
        revision: r.revision,
        text: canonicalText
      });
    }
  }

  // Deduplication by [entity, eventTime, text]
  const groups = new Map();
  for (const row of allRows) {
    const key = JSON.stringify([row.entity, row.eventTime, row.text]);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  const retainedRows = [];
  const rejectedRowsMap = new Map();

  function rejectRow(id, reasonCode) {
    if (!rejectedRowsMap.has(id)) {
      rejectedRowsMap.set(id, new Set());
    }
    rejectedRowsMap.get(id).add(reasonCode);
  }

  for (const [key, groupRows] of groups) {
    groupRows.sort((a, b) => {
      if (b.revision !== a.revision) {
        return b.revision - a.revision;
      }
      return utf8Compare(a.id, b.id);
    });

    const winner = groupRows[0];
    retainedRows.push(winner);

    for (let i = 1; i < groupRows.length; i++) {
      rejectRow(groupRows[i].id, "DUPLICATE");
    }
  }

  // Splits
  const splits = {
    train: [],
    validation: [],
    test: []
  };

  if (!isPolicyValid) {
    for (const row of retainedRows) {
      rejectRow(row.id, "POLICY_INVALID");
    }
  } else {
    const trainRows = [];
    const evalRows = [];

    for (const row of retainedRows) {
      if (row.eventTime < minTimeNorm || row.eventTime > maxTimeNorm) {
        rejectRow(row.id, "OUT_OF_WINDOW");
        continue;
      }

      const entityBytes = new TextEncoder().encode(row.entity);
      const sha256Hex = crypto.createHash('sha256').update(entityBytes).digest('hex');
      const firstByte = parseInt(sha256Hex.substring(0, 2), 16);
      const bucket = firstByte % 10;

      if (bucket >= 0 && bucket <= 5) {
        trainRows.push(row);
      } else if (bucket >= 6 && bucket <= 7) {
        evalRows.push({ row, split: 'validation' });
      } else if (bucket >= 8 && bucket <= 9) {
        evalRows.push({ row, split: 'test' });
      }
    }

    const trainWordSets = trainRows.map(r => getWordSet(r.text));

    const acceptedValidationRows = [];
    const acceptedTestRows = [];

    for (const { row, split } of evalRows) {
      const evalWordSet = getWordSet(row.text);
      let isContaminated = false;

      for (const trainSet of trainWordSets) {
        const sim = jaccardSimilarity(evalWordSet, trainSet);
        if (sim >= threshold) {
          isContaminated = true;
          break;
        }
      }

      if (isContaminated) {
        rejectRow(row.id, "TRAIN_CONTAMINATION");
      } else {
        if (split === 'validation') {
          acceptedValidationRows.push(row);
        } else if (split === 'test') {
          acceptedTestRows.push(row);
        }
      }
    }

    splits.train = trainRows;
    splits.validation = acceptedValidationRows;
    splits.test = acceptedTestRows;
  }

  // Sort splits
  function serializeRowCompact(row) {
    return JSON.stringify({
      id: row.id,
      entity: row.entity,
      eventTime: row.eventTime,
      revision: row.revision,
      text: row.text
    });
  }

  function sortSplitRows(rowList) {
    rowList.sort((a, b) => {
      const cmpId = utf8Compare(a.id, b.id);
      if (cmpId !== 0) return cmpId;
      const compactA = serializeRowCompact(a);
      const compactB = serializeRowCompact(b);
      return utf8Compare(compactA, compactB);
    });
  }

  sortSplitRows(splits.train);
  sortSplitRows(splits.validation);
  sortSplitRows(splits.test);

  // Compute digests
  function computeSplitDigest(rowList) {
    if (rowList.length === 0) {
      return crypto.createHash('sha256').update(new Uint8Array(0)).digest('hex');
    }
    const lines = rowList.map(r => serializeRowCompact(r) + "\n");
    const fullStr = lines.join('');
    const bytes = new TextEncoder().encode(fullStr);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  const digests = {
    train: computeSplitDigest(splits.train),
    validation: computeSplitDigest(splits.validation),
    test: computeSplitDigest(splits.test)
  };

  // Format rejectedRows array
  const rejectedRows = [];
  for (const [id, codesSet] of rejectedRowsMap.entries()) {
    const reasonCodes = Array.from(codesSet).sort(utf8Compare);
    rejectedRows.push({
      id,
      reasonCodes
    });
  }

  // Sort lists
  rejectedObjects.sort((a, b) => {
    if (typeof a.uri === "string" && typeof b.uri === "string") {
      const cmp = utf8Compare(a.uri, b.uri);
      if (cmp !== 0) return cmp;
    }
    return utf8Compare(JSON.stringify(a), JSON.stringify(b));
  });

  rejectedRows.sort((a, b) => {
    const cmp = utf8Compare(a.id, b.id);
    if (cmp !== 0) return cmp;
    return utf8Compare(JSON.stringify(a), JSON.stringify(b));
  });

  lineage.sort((a, b) => {
    const cmp = utf8Compare(a.uri, b.uri);
    if (cmp !== 0) return cmp;
    return utf8Compare(JSON.stringify(a), JSON.stringify(b));
  });

  const responseObj = {
    splits: {
      train: splits.train.map(r => ({
        id: r.id,
        entity: r.entity,
        eventTime: r.eventTime,
        revision: r.revision,
        text: r.text
      })),
      validation: splits.validation.map(r => ({
        id: r.id,
        entity: r.entity,
        eventTime: r.eventTime,
        revision: r.revision,
        text: r.text
      })),
      test: splits.test.map(r => ({
        id: r.id,
        entity: r.entity,
        eventTime: r.eventTime,
        revision: r.revision,
        text: r.text
      }))
    },
    rejectedObjects,
    rejectedRows,
    digests,
    lineage
  };

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}