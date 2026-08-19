// Global In-Memory Store for Run IDs across requests
const RUN_STORE = new Map();

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

function parseTimestamp(str) {
  if (typeof str !== 'string') return null;
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):?(\d{2}))?$/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);
  const msStr = match[7];
  const signStr = match[8];
  const tzHStr = match[9];
  const tzMinStr = match[10];

  if (month < 1 || month > 12) return null;

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const daysInMonth = [0, 31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month]) return null;

  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (tzHStr !== undefined && tzMinStr !== undefined) {
    const tzH = parseInt(tzHStr, 10);
    const tzMin = parseInt(tzMinStr, 10);
    if (tzH > 14 || (tzH === 14 && tzMin !== 0) || tzMin > 59) return null;
    offsetMinutes = tzH * 60 + tzMin;
    if (signStr === '-') offsetMinutes = -offsetMinutes;
  }

  let ms = 0;
  if (msStr) {
    ms = parseInt(msStr.padEnd(3, '0'), 10);
  }

  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, ms);
  const utcMs = d.getTime() - offsetMinutes * 60 * 1000;

  if (isNaN(utcMs)) return null;

  return utcMs;
}

async function sha256Hex(str) {
  const buffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function isDeepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) || Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!isDeepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

export async function handleBqml(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    console.log("[BQML LOG] Invalid JSON body");
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    console.log("[BQML LOG] Body not an object");
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const { phase } = body;

  if (phase === "select") {
    return await handleSelectPhase(body);
  } else if (phase === "evaluate") {
    return await handleEvaluatePhase(body);
  } else {
    console.log(`[BQML LOG] Unknown phase: ${phase}`);
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
}

async function handleSelectPhase(body) {
  const { runId, forbiddenFeatures, numTrialsLimit, rows, trials } = body;

  const isRunIdValidStr = typeof runId === "string" && runId.length > 0 && runId.length <= 128;

  if (isRunIdValidStr && RUN_STORE.has(runId)) {
    const stored = RUN_STORE.get(runId);
    if (isDeepEqual(stored.inputBodyObj, body)) {
      console.log(`[BQML SELECT LOG] runId=${runId} status=REPLAY_200`);
      return new Response(JSON.stringify(stored.selectResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      console.log(`[BQML SELECT LOG] runId=${runId} status=CONFLICT_409`);
      return new Response(JSON.stringify({ error: "RUN_ID_CONFLICT" }), {
        status: 409,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  const reasonCodes = [];
  let isSchemaValid = true;

  if (!isRunIdValidStr) isSchemaValid = false;
  if (!Array.isArray(forbiddenFeatures) || forbiddenFeatures.some(f => typeof f !== "string")) isSchemaValid = false;
  if (typeof numTrialsLimit !== "number" || !Number.isSafeInteger(numTrialsLimit) || numTrialsLimit <= 0) isSchemaValid = false;
  if (!Array.isArray(rows) || rows.length === 0) isSchemaValid = false;
  if (!Array.isArray(trials)) isSchemaValid = false;

  const parsedRows = [];
  const seenRowIds = new Set();

  if (isSchemaValid && Array.isArray(rows)) {
    for (const r of rows) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        isSchemaValid = false;
        break;
      }
      const { id, entity, eventTime, predictionTime, version, split, features } = r;

      if (typeof id !== "string" || id.length === 0 || seenRowIds.has(id)) {
        isSchemaValid = false;
        break;
      }
      seenRowIds.add(id);

      if (typeof entity !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        isSchemaValid = false;
        break;
      }

      if (split !== "TRAIN" && split !== "EVAL") {
        isSchemaValid = false;
        break;
      }

      const eventUtcMs = parseTimestamp(eventTime);
      const predUtcMs = parseTimestamp(predictionTime);

      if (eventUtcMs === null || predUtcMs === null) {
        isSchemaValid = false;
        break;
      }

      if (!features || typeof features !== "object" || Array.isArray(features)) {
        isSchemaValid = false;
        break;
      }

      const parsedFeatures = {};
      for (const [fName, fObj] of Object.entries(features)) {
        if (!fObj || typeof fObj !== "object" || Array.isArray(fObj)) {
          isSchemaValid = false;
          break;
        }
        const { value, availableAt } = fObj;
        if (value === undefined || typeof availableAt !== "string") {
          isSchemaValid = false;
          break;
        }
        const availUtcMs = parseTimestamp(availableAt);
        if (availUtcMs === null) {
          isSchemaValid = false;
          break;
        }
        parsedFeatures[fName] = { value, availableAtMs: availUtcMs };
      }

      if (!isSchemaValid) break;

      parsedRows.push({
        id,
        entity,
        eventUtcMs,
        predMs: predUtcMs,
        version,
        split,
        features: parsedFeatures
      });
    }
  }

  const parsedTrials = [];
  const seenTrialIds = new Set();

  if (isSchemaValid && Array.isArray(trials)) {
    for (const t of trials) {
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        isSchemaValid = false;
        break;
      }
      const { trialId, status, evalMetric } = t;

      if (typeof trialId !== "number" || !Number.isSafeInteger(trialId) || trialId < 0 || seenTrialIds.has(trialId)) {
        isSchemaValid = false;
        break;
      }
      seenTrialIds.add(trialId);

      if (status !== "SUCCEEDED" && status !== "FAILED") {
        isSchemaValid = false;
        break;
      }

      parsedTrials.push({ trialId, status, evalMetric });
    }
  }

  if (!isSchemaValid) {
    reasonCodes.push("INVALID_INPUT");
  }

  let trainRowIds = [];
  let evalRowIds = [];
  let featureNames = [];
  let datasetDigest = null;
  let selectedTrialId = null;

  if (isSchemaValid) {
    const groups = new Map();
    for (const r of parsedRows) {
      const key = JSON.stringify([r.entity, r.eventUtcMs]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const retainedRows = [];
    for (const group of groups.values()) {
      group.sort((a, b) => {
        if (b.version !== a.version) return b.version - a.version;
        return utf8Compare(a.id, b.id);
      });
      retainedRows.push(group[0]);
    }

    trainRowIds = retainedRows.filter(r => r.split === "TRAIN").map(r => r.id).sort(utf8Compare);
    evalRowIds = retainedRows.filter(r => r.split === "EVAL").map(r => r.id).sort(utf8Compare);

    const forbiddenSet = new Set(forbiddenFeatures);
    const candidateFeatures = new Set();

    if (retainedRows.length > 0) {
      for (const fName of Object.keys(retainedRows[0].features)) {
        if (!forbiddenSet.has(fName)) candidateFeatures.add(fName);
      }

      for (let i = 1; i < retainedRows.length; i++) {
        const rowFeatureSet = new Set(Object.keys(retainedRows[i].features));
        for (const fName of Array.from(candidateFeatures)) {
          if (!rowFeatureSet.has(fName)) {
            candidateFeatures.delete(fName);
          }
        }
      }

      for (const fName of Array.from(candidateFeatures)) {
        let allAvailable = true;
        for (const r of retainedRows) {
          const fObj = r.features[fName];
          if (fObj.availableAtMs > r.predMs) {
            allAvailable = false;
            break;
          }
        }
        if (allAvailable) {
          featureNames.push(fName);
        }
      }
    }

    featureNames.sort(utf8Compare);

    const digestObject = { trainRowIds, evalRowIds, featureNames };
    datasetDigest = await sha256Hex(JSON.stringify(digestObject));

    if (parsedTrials.length > numTrialsLimit) {
      reasonCodes.push("TRIAL_LIMIT_EXCEEDED");
    }

    const eligibleTrials = parsedTrials.filter(
      t => t.status === "SUCCEEDED" && typeof t.evalMetric === "number" && Number.isFinite(t.evalMetric)
    );

    if (eligibleTrials.length === 0) {
      reasonCodes.push("NO_SUCCESSFUL_TRIAL");
    } else {
      eligibleTrials.sort((a, b) => {
        if (b.evalMetric !== a.evalMetric) return b.evalMetric - a.evalMetric;
        return a.trialId - b.trialId;
      });
      selectedTrialId = eligibleTrials[0].trialId;
    }
  }

  const sortedReasonCodes = Array.from(new Set(reasonCodes)).sort(utf8Compare);

  if (sortedReasonCodes.length > 0) {
    selectedTrialId = null;
    if (sortedReasonCodes.includes("INVALID_INPUT")) {
      datasetDigest = null;
      trainRowIds = [];
      evalRowIds = [];
      featureNames = [];
    }
  }

  const responseObj = {
    runId: typeof runId === "string" ? runId : "",
    selectedTrialId,
    trainRowIds: isSchemaValid ? trainRowIds : [],
    evalRowIds: isSchemaValid ? evalRowIds : [],
    featureNames: isSchemaValid ? featureNames : [],
    datasetDigest,
    reasonCodes: sortedReasonCodes
  };

  if (isRunIdValidStr) {
    RUN_STORE.set(runId, {
      inputBodyObj: body,
      selectResponse: responseObj
    });
  }

  console.log(`[BQML SELECT LOG] runId=${runId} trial=${selectedTrialId} digest=${datasetDigest} reasons=${JSON.stringify(sortedReasonCodes)}`);

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleEvaluatePhase(body) {
  const {
    runId,
    selectedTrialId,
    datasetDigest,
    metricFloor,
    requiredSlices,
    rows,
    bytesProcessed,
    maxBytes
  } = body;

  const reasonCodes = [];

  // 1. Lineage Check
  let isLineageValid = true;

  if (typeof runId === "string" && RUN_STORE.has(runId)) {
    const storedRun = RUN_STORE.get(runId).selectResponse;
    if (
      storedRun.selectedTrialId === null ||
      storedRun.datasetDigest === null ||
      storedRun.reasonCodes.length > 0 ||
      storedRun.selectedTrialId !== selectedTrialId ||
      storedRun.datasetDigest !== datasetDigest
    ) {
      isLineageValid = false;
    }
  } else {
    isLineageValid = false;
  }

  if (!isLineageValid) {
    reasonCodes.push("INVALID_LINEAGE");
  }

  // 2. Schema Validation
  let isSchemaValid = true;

  if (typeof runId !== "string" || runId.length === 0 || runId.length > 128) isSchemaValid = false;
  if (typeof selectedTrialId !== "number" || !Number.isSafeInteger(selectedTrialId) || selectedTrialId < 0) isSchemaValid = false;
  if (typeof datasetDigest !== "string" || !/^[0-9a-f]{64}$/.test(datasetDigest)) isSchemaValid = false;
  if (typeof metricFloor !== "number" || !Number.isFinite(metricFloor) || metricFloor < 0 || metricFloor > 1) isSchemaValid = false;

  if (!requiredSlices || typeof requiredSlices !== "object" || Array.isArray(requiredSlices)) {
    isSchemaValid = false;
  } else {
    for (const [sName, sFloor] of Object.entries(requiredSlices)) {
      if (typeof sName !== "string" || sName.length === 0 || typeof sFloor !== "number" || !Number.isFinite(sFloor) || sFloor < 0 || sFloor > 1) {
        isSchemaValid = false;
        break;
      }
    }
  }

  if (!Array.isArray(rows)) isSchemaValid = false;
  if (typeof bytesProcessed !== "number" || !Number.isSafeInteger(bytesProcessed) || bytesProcessed < 0) isSchemaValid = false;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 0) isSchemaValid = false;

  if (!isSchemaValid) {
    reasonCodes.push("INVALID_INPUT");
  }

  // 3. Row Validation
  let isRowsValid = true;
  if (Array.isArray(rows) && rows.length > 0) {
    for (const r of rows) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        isRowsValid = false;
        break;
      }
      const { label, prediction, slice } = r;
      if (label !== 0 && label !== 1) {
        isRowsValid = false;
        break;
      }
      if (prediction !== 0 && prediction !== 1) {
        isRowsValid = false;
        break;
      }
      if (typeof slice !== "string" || slice.length === 0) {
        isRowsValid = false;
        break;
      }
    }
    if (!isRowsValid) {
      reasonCodes.push("INVALID_TEST_ROW");
    }
  }

  // 4. Metric Computation & Slice Checks
  let testMetric = null;

    if (Array.isArray(rows) && isRowsValid && rows.length > 0) {
    const sliceGroupRows = new Map();
    for (const r of rows) {
      if (!sliceGroupRows.has(r.slice)) sliceGroupRows.set(r.slice, []);
      sliceGroupRows.get(r.slice).push(r);
    }

    const totalCount = rows.length;
    let correctCount = 0;
    for (const r of rows) {
      if (r.label === r.prediction) correctCount++;
    }

    const rawAccuracy = correctCount / totalCount;
    testMetric = Number(rawAccuracy.toFixed(12));

    // Aggregate floor check
    if (typeof metricFloor === "number" && Number.isFinite(metricFloor)) {
      const metricFloor12 = Number(metricFloor.toFixed(12));
      if (testMetric < metricFloor12) {
        reasonCodes.push("AGGREGATE_FLOOR");
      }
    }

    // Required-slice checks (missing + floor) only run when rows are non-empty and valid
    if (requiredSlices && typeof requiredSlices === "object" && !Array.isArray(requiredSlices)) {
      for (const [reqSliceName, reqSliceFloor] of Object.entries(requiredSlices)) {
        if (typeof reqSliceName === "string" && typeof reqSliceFloor === "number" && Number.isFinite(reqSliceFloor)) {
          if (!sliceGroupRows.has(reqSliceName)) {
            reasonCodes.push(`MISSING_SLICE:${reqSliceName}`);
          } else {
            const sliceRows = sliceGroupRows.get(reqSliceName);
            let sCorrect = 0;
            for (const sr of sliceRows) {
              if (sr.label === sr.prediction) sCorrect++;
            }
            const sAcc = Number((sCorrect / sliceRows.length).toFixed(12));
            const reqFloor12 = Number(reqSliceFloor.toFixed(12));
            if (sAcc < reqFloor12) {
              reasonCodes.push(`SLICE_FLOOR:${reqSliceName}`);
            }
          }
        }
      }
    }
  } else {
    testMetric = null;
  }

  // 5. Byte Limit Check
  if (typeof bytesProcessed === "number" && typeof maxBytes === "number" && bytesProcessed > maxBytes) {
    reasonCodes.push("BYTE_LIMIT");
  }

  const sortedReasonCodes = Array.from(new Set(reasonCodes)).sort(utf8Compare);

  // Decision Logic
  const decision = (sortedReasonCodes.length === 0) ? "admit" : "reject";

  // Critical Slice Pass Logic
  const criticalSlicePass = Array.isArray(rows) && rows.length > 0 && !(
    sortedReasonCodes.includes("INVALID_INPUT") ||
    sortedReasonCodes.includes("INVALID_LINEAGE") ||
    sortedReasonCodes.includes("INVALID_TEST_ROW") ||
    sortedReasonCodes.some(code => code.startsWith("MISSING_SLICE:")) ||
    sortedReasonCodes.some(code => code.startsWith("SLICE_FLOOR:"))
  );

  const responseObj = {
    runId: typeof runId === "string" ? runId : "",
    selectedTrialId: typeof selectedTrialId === "number" ? selectedTrialId : null,
    datasetDigest: typeof datasetDigest === "string" ? datasetDigest : null,
    testMetric,
    criticalSlicePass,
    decision,
    bytesProcessed: typeof bytesProcessed === "number" ? bytesProcessed : 0,
    reasonCodes: sortedReasonCodes
  };

  console.log(`[BQML EVAL LOG] runId=${runId} testMetric=${testMetric} pass=${criticalSlicePass} decision=${decision} reasons=${JSON.stringify(sortedReasonCodes)}`);

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
