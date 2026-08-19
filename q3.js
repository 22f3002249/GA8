// Global In-Memory Store for Mutated Champion Aliases
const ALIAS_STORE = new Map();

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

function isValidCanonicalVersion(vStr) {
  if (typeof vStr !== "string") return false;
  if (!/^[1-9]\d*$/.test(vStr)) return false;
  const num = Number(vStr);
  if (!Number.isSafeInteger(num) || num <= 0) return false;
  return String(num) === vStr;
}

export async function handlePromote(request) {
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

  const { asOf, championVersion, policy, versions } = body;

  // Schema Validation for HTTP 400 INVALID_INPUT
  if (typeof asOf !== "string" || parseTimestamp(asOf) === null) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (typeof championVersion !== "string" || championVersion.length === 0) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (!Array.isArray(versions)) {
    return new Response(JSON.stringify({ error: "INVALID_INPUT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const asOfUtcMs = parseTimestamp(asOf);

  // Validate Policy Fields
  let isPolicyValid = true;
  const {
    datasetDigest,
    schemaDigest,
    maxAgeSeconds,
    accuracyFloor,
    requiredSlices,
    maxLatencyMs,
    maxSizeBytes,
    minImprovement
  } = policy;

  if (typeof datasetDigest !== "string" || datasetDigest.length === 0) isPolicyValid = false;
  if (typeof schemaDigest !== "string" || schemaDigest.length === 0) isPolicyValid = false;
  if (typeof maxAgeSeconds !== "number" || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) isPolicyValid = false;
  if (typeof accuracyFloor !== "number" || !Number.isFinite(accuracyFloor) || accuracyFloor < 0 || accuracyFloor > 1) isPolicyValid = false;
  if (typeof maxLatencyMs !== "number" || !Number.isFinite(maxLatencyMs) || maxLatencyMs < 0) isPolicyValid = false;
  if (typeof maxSizeBytes !== "number" || !Number.isSafeInteger(maxSizeBytes) || maxSizeBytes < 0) isPolicyValid = false;
  if (typeof minImprovement !== "number" || !Number.isFinite(minImprovement) || minImprovement < 0 || minImprovement > 1) isPolicyValid = false;

  if (!requiredSlices || typeof requiredSlices !== "object" || Array.isArray(requiredSlices)) {
    isPolicyValid = false;
  } else {
    for (const [sName, sFloor] of Object.entries(requiredSlices)) {
      if (typeof sName !== "string" || sName.length === 0 || typeof sFloor !== "number" || !Number.isFinite(sFloor) || sFloor < 0 || sFloor > 1) {
        isPolicyValid = false;
        break;
      }
    }
  }

  // Count version occurrences across all elements in versions array
  const versionCounts = new Map();
  for (const vObj of versions) {
    let vKey = "INVALID_VERSION";
    if (typeof vObj === "string" || typeof vObj === "number") {
      vKey = String(vObj);
    } else if (vObj && typeof vObj === "object" && !Array.isArray(vObj)) {
      if (vObj.version !== undefined && vObj.version !== null) {
        vKey = String(vObj.version);
      }
    }
    versionCounts.set(vKey, (versionCounts.get(vKey) || 0) + 1);
  }

  const failedGates = {};
  const parsedVersionList = [];

  for (const vObj of versions) {
    let vKey = "INVALID_VERSION";
    let vRaw = undefined;

    if (typeof vObj === "string" || typeof vObj === "number") {
      vKey = String(vObj);
    } else if (vObj && typeof vObj === "object" && !Array.isArray(vObj)) {
      vRaw = vObj.version;
      vKey = (vRaw !== undefined && vRaw !== null) ? String(vRaw) : "INVALID_VERSION";
    }

    const vCodes = [];

    // Check if element itself is an object
    if (!vObj || typeof vObj !== "object" || Array.isArray(vObj)) {
      vCodes.push("INVALID_VERSION");
    } else {
      // 1. Version ID Format & Duplicates
      if (!isValidCanonicalVersion(vRaw)) {
        vCodes.push("INVALID_VERSION");
      }

      if (versionCounts.get(vKey) > 1) {
        vCodes.push("DUPLICATE_VERSION");
      }

      if (!isPolicyValid) {
        vCodes.push("INVALID_POLICY");
      }

      const { artifactDigest, evaluation } = vObj;

      if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
        vCodes.push("MISSING_EVALUATION");
      } else {
        const {
          createdAt,
          artifactDigest: evalArtifactDigest,
          datasetDigest: evalDatasetDigest,
          schemaDigest: evalSchemaDigest,
          accuracy,
          latencyMs,
          sizeBytes,
          slices
        } = evaluation;

        // 2. Timestamps
        const createdUtcMs = parseTimestamp(createdAt);
        if (createdUtcMs === null) {
          vCodes.push("INVALID_TIMESTAMP");
        } else if (isPolicyValid) {
          if (createdUtcMs > asOfUtcMs) {
            vCodes.push("FUTURE_EVALUATION");
          } else if (createdUtcMs < (asOfUtcMs - maxAgeSeconds * 1000)) {
            vCodes.push("STALE_EVALUATION");
          }
        }

        // 3. Digest Mismatches
        if (typeof evalArtifactDigest !== "string" || typeof artifactDigest !== "string" || evalArtifactDigest !== artifactDigest) {
          vCodes.push("ARTIFACT_MISMATCH");
        }

        if (isPolicyValid) {
          if (typeof evalDatasetDigest !== "string" || evalDatasetDigest !== datasetDigest) {
            vCodes.push("DATASET_MISMATCH");
          }
          if (typeof evalSchemaDigest !== "string" || evalSchemaDigest !== schemaDigest) {
            vCodes.push("SCHEMA_MISMATCH");
          }
        }

        // 4. Accuracy
        if (typeof accuracy !== "number" || !Number.isFinite(accuracy)) {
          vCodes.push("NON_FINITE");
        } else if (accuracy < 0 || accuracy > 1) {
          vCodes.push("METRIC_RANGE");
        } else if (isPolicyValid) {
          const acc12 = Number(accuracy.toFixed(12));
          const floor12 = Number(accuracyFloor.toFixed(12));
          if (acc12 < floor12) {
            vCodes.push("ACCURACY_FLOOR");
          }
        }

        // 5. Latency
        if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
          vCodes.push("NON_FINITE");
        } else if (latencyMs < 0) {
          vCodes.push("METRIC_RANGE");
        } else if (isPolicyValid) {
          if (latencyMs > maxLatencyMs) {
            vCodes.push("LATENCY_LIMIT");
          }
        }

        // 6. Size
        if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || !Number.isSafeInteger(sizeBytes)) {
          vCodes.push("NON_FINITE");
        } else if (sizeBytes < 0) {
          vCodes.push("METRIC_RANGE");
        } else if (isPolicyValid) {
          if (sizeBytes > maxSizeBytes) {
            vCodes.push("SIZE_LIMIT");
          }
        }

        // 7. Slices
        if (!slices || typeof slices !== "object" || Array.isArray(slices)) {
          if (isPolicyValid && requiredSlices) {
            for (const reqSliceName of Object.keys(requiredSlices)) {
              vCodes.push(`MISSING_SLICE:${reqSliceName}`);
            }
          }
        } else {
          // Check present slices
          for (const [sName, sVal] of Object.entries(slices)) {
            if (typeof sVal !== "number" || !Number.isFinite(sVal)) {
              vCodes.push("NON_FINITE");
            } else if (sVal < 0 || sVal > 1) {
              vCodes.push(`SLICE_RANGE:${sName}`);
            }
          }

          // Check required slices
          if (isPolicyValid && requiredSlices) {
            for (const [reqSliceName, reqSliceFloor] of Object.entries(requiredSlices)) {
              if (slices[reqSliceName] === undefined) {
                vCodes.push(`MISSING_SLICE:${reqSliceName}`);
              } else {
                const sVal = slices[reqSliceName];
                if (typeof sVal === "number" && Number.isFinite(sVal) && sVal >= 0 && sVal <= 1) {
                  const sVal12 = Number(sVal.toFixed(12));
                  const reqFloor12 = Number(reqSliceFloor.toFixed(12));
                  if (sVal12 < reqFloor12) {
                    vCodes.push(`SLICE_FLOOR:${reqSliceName}`);
                  }
                }
              }
            }
          }
        }
      }
    }

    const sortedVCodes = Array.from(new Set(vCodes)).sort(utf8Compare);
    if (sortedVCodes.length > 0) {
      failedGates[vKey] = sortedVCodes;
    } else {
      parsedVersionList.push(vObj);
    }
  }

  // Scoped Alias Key
  const storeKey = `${asOf}:${datasetDigest || ""}:${schemaDigest || ""}:${championVersion}`;
  let effectiveChampionVersion = championVersion;

  if (isPolicyValid && ALIAS_STORE.has(storeKey)) {
    const mutatedVersion = ALIAS_STORE.get(storeKey);
    const mutatedObj = versions.find(v => v && typeof v === "object" && String(v.version) === String(mutatedVersion));
    if (mutatedObj && !failedGates[mutatedVersion]) {
      effectiveChampionVersion = mutatedVersion;
    }
  }

  // Find Champion Version Object
  const championObj = versions.find(v => v && typeof v === "object" && String(v.version) === String(effectiveChampionVersion));
  const isChampionEligible = championObj && !failedGates[effectiveChampionVersion];

  // Rank Eligible Versions: accuracy desc, latency asc, size asc, version asc
  parsedVersionList.sort((a, b) => {
    const accA = Number(a.evaluation.accuracy.toFixed(12));
    const accB = Number(b.evaluation.accuracy.toFixed(12));
    if (accB !== accA) return accB - accA;

    if (a.evaluation.latencyMs !== b.evaluation.latencyMs) {
      return a.evaluation.latencyMs - b.evaluation.latencyMs;
    }

    if (a.evaluation.sizeBytes !== b.evaluation.sizeBytes) {
      return a.evaluation.sizeBytes - b.evaluation.sizeBytes;
    }

    return Number(a.version) - Number(b.version);
  });

  const eligibleVersions = parsedVersionList.map(v => String(v.version));

  let action = "block";
  let selectedVersion = null;
  let aliasMutation = null;
  let evidence = null;

  if (!isPolicyValid || !isChampionEligible) {
    action = "block";
    selectedVersion = null;
    evidence = null;
    aliasMutation = null;
  } else {
    const topVersionObj = parsedVersionList[0];
    if (String(topVersionObj.version) === String(effectiveChampionVersion)) {
      action = "retain";
      selectedVersion = String(effectiveChampionVersion);
      evidence = championObj.evaluation;
      aliasMutation = null;
    } else {
      const topAcc12 = Number(topVersionObj.evaluation.accuracy.toFixed(12));
      const champAcc12 = Number(championObj.evaluation.accuracy.toFixed(12));
      const improvement = Number((topAcc12 - champAcc12).toFixed(12));
      const minImp12 = Number(minImprovement.toFixed(12));

      if (improvement >= minImp12) {
        action = "promote";
        selectedVersion = String(topVersionObj.version);
        evidence = topVersionObj.evaluation;
        aliasMutation = { alias: "champion", version: selectedVersion };
        ALIAS_STORE.set(storeKey, selectedVersion);
        ALIAS_STORE.set(`${asOf}:${datasetDigest || ""}:${schemaDigest || ""}:${selectedVersion}`, selectedVersion);
      } else {
        action = "retain";
        selectedVersion = String(effectiveChampionVersion);
        evidence = championObj.evaluation;
        aliasMutation = null;
      }
    }
  }

  const responseObj = {
    action,
    championVersion: String(effectiveChampionVersion),
    selectedVersion,
    eligibleVersions,
    failedGates,
    aliasMutation,
    evidence
  };

  return new Response(JSON.stringify(responseObj), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}