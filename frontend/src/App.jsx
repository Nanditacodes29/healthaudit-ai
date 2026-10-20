
import { useState } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = 'https://healthaudit-ai.onrender.com';

const CONDITIONS = [
  { key: 'alzheimer', label: "Alzheimer's / Dementia", severity: 2 },
  { key: 'chf', label: 'Heart Failure', severity: 4 },
  { key: 'kidney', label: 'Kidney Disease', severity: 4 },
  { key: 'cancer', label: 'Cancer', severity: 5 },
  { key: 'copd', label: 'COPD (lung disease)', severity: 3 },
  { key: 'depression', label: 'Depression', severity: 1 },
  { key: 'diabetes', label: 'Diabetes', severity: 2 },
  { key: 'ischemic', label: 'Heart Disease', severity: 4 },
  { key: 'osteoporosis', label: 'Osteoporosis', severity: 1 },
  { key: 'arthritis', label: 'Arthritis', severity: 1 },
  { key: 'stroke', label: 'Stroke History', severity: 4 },
];

const initialForm = {
  patientId: '',
  claimId: '',
  name: '',
  age: '',
  sex: '1',
  conditions: {},
  document: null,
  extractedCost: null,
  extractedDays: null,
  manualCost: '',
  manualDays: '',
  needsManualFallback: false,
};

function signedLog(x) {
  if (x === 0) return 0;
  return Math.sign(x) * Math.log1p(Math.abs(x));
}

async function extractFromPdf(file) {
  try {
    if (!window.pdfjsLib) {
      return { cost: null, days: null };
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({
      data: arrayBuffer,
    }).promise;

    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map((item) => item.str).join(' ') + ' ';
    }

    const dollarMatches = [
      ...fullText.matchAll(/\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/g),
    ]
      .map((match) => parseFloat(match[1].replace(/,/g, '')))
      .filter((value) => !Number.isNaN(value));

    const cost = dollarMatches.length
      ? Math.max(...dollarMatches)
      : null;

    const dayMatches = [
      ...fullText.matchAll(/\b(\d+)\s*(?:day|days)\b/gi),
    ]
      .map((match) => parseInt(match[1], 10))
      .filter((value) => !Number.isNaN(value) && value < 365);

    const days = dayMatches.length ? Math.max(...dayMatches) : null;

    return { cost, days };
  } catch (error) {
    console.error('PDF extraction failed:', error);
    return { cost: null, days: null };
  }
}

function estimateClaimFeatures(form) {
  const age = Number(form.age) || 50;
  const checkedConditions = CONDITIONS.filter(
    (condition) => form.conditions[condition.key]
  );

  const chronicConditionCount = checkedConditions.length;
  const severitySum = checkedConditions.reduce(
    (sum, condition) => sum + condition.severity,
    0
  );

  const ageFactor = age > 70 ? 1.4 : age > 50 ? 1.1 : 0.8;

  const totalCost =
    form.extractedCost ??
    (Number(form.manualCost) || (500 + severitySum * 900) * ageFactor);

  const seriousCount = checkedConditions.filter(
    (condition) => condition.severity >= 4
  ).length;

  const inpatientDays =
    form.extractedDays ??
    (Number(form.manualDays) || seriousCount * 3 * ageFactor);

  const inpatientVisits =
    inpatientDays > 0 ? Math.max(1, Math.round(seriousCount)) : 0;

  const outpatientVisits = Math.max(1, chronicConditionCount);
  const inpatientDiagnoses =
    inpatientVisits > 0 ? Math.max(1, Math.round(severitySum / 2)) : 0;

  const outpatientDiagnoses = Math.max(1, chronicConditionCount);

  const inpatientPayment =
    inpatientVisits > 0 ? totalCost * 0.7 : 0;

  const outpatientPayment =
    inpatientVisits > 0 ? totalCost * 0.3 : totalCost;

  const totalClaims = Math.max(inpatientVisits + outpatientVisits, 1);
  const flag = (key) => (form.conditions[key] ? 1 : 0);

  return {
    BENE_ESRD_IND: 0,
    BENE_HI_CVRAGE_TOT_MONS: 12,
    BENE_SMI_CVRAGE_TOT_MONS: 12,
    BENE_HMO_CVRAGE_TOT_MONS: 0,
    PLAN_CVRG_MOS_NUM: 12,
    age,
    is_deceased: 0,

    SP_ALZHDMTA: flag('alzheimer'),
    SP_CHF: flag('chf'),
    SP_CHRNKIDN: flag('kidney'),
    SP_CNCR: flag('cancer'),
    SP_COPD: flag('copd'),
    SP_DEPRESSN: flag('depression'),
    SP_DIABETES: flag('diabetes'),
    SP_ISCHMCHT: flag('ischemic'),
    SP_OSTEOPRS: flag('osteoporosis'),
    SP_RA_OA: flag('arthritis'),
    SP_STRKETIA: flag('stroke'),

    chronic_condition_count: chronicConditionCount,

    MEDREIMB_IP: inpatientPayment,
    BENRES_IP: 0,
    PPPYMT_IP: 0,
    MEDREIMB_OP: outpatientPayment,
    BENRES_OP: 0,
    PPPYMT_OP: 0,
    MEDREIMB_CAR: 0,
    BENRES_CAR: 0,
    PPPYMT_CAR: 0,

    total_inpatient_claims: inpatientVisits,
    distinct_inpatient_diagnosis_codes: inpatientDiagnoses,
    total_outpatient_claims: outpatientVisits,
    distinct_outpatient_diagnosis_codes: outpatientDiagnoses,

    total_inpatient_payment_amt_log: signedLog(inpatientPayment),
    total_outpatient_payment_amt_log: signedLog(outpatientPayment),
    total_inpatient_primary_payer_amt_log: 0,
    total_outpatient_primary_payer_amt_log: 0,
    total_inpatient_days_log: signedLog(inpatientDays),

    avg_inpatient_payment_amt_log: signedLog(
      inpatientPayment / Math.max(inpatientVisits, 1)
    ),
    avg_outpatient_payment_amt_log: signedLog(
      outpatientPayment / Math.max(outpatientVisits, 1)
    ),

    cost_per_claim: totalCost / totalClaims,
    BENE_SEX_IDENT_CD: form.sex,
    BENE_RACE_CD: '1',
    SP_STATE_CODE: '34',
    BENE_COUNTY_CD: '230',
  };
}

function readableFeatureName(feature) {
  const nameMap = {
    numeric__total_outpatient_claims: 'Number of outpatient visits',
    numeric__total_inpatient_payment_amt_log: 'Hospital care cost',
    numeric__total_inpatient_days_log: 'Days spent in hospital',
    numeric__total_outpatient_payment_amt_log: 'Outpatient care cost',
    numeric__distinct_inpatient_diagnosis_codes:
      'Number of health issues found during hospital stay',
    numeric__distinct_outpatient_diagnosis_codes:
      'Number of health issues found during outpatient visits',
    numeric__avg_inpatient_payment_amt_log: 'Average hospital care cost',
    numeric__avg_outpatient_payment_amt_log: 'Average outpatient care cost',
    numeric__chronic_condition_count: 'Number of ongoing health conditions',
    numeric__cost_per_claim: 'Overall cost of care',
    numeric__age: 'Age',
  };

  if (nameMap[feature]) return nameMap[feature];

  return feature
    .replace(/^numeric__/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function buildPlainReason(result) {
  const isDeny = result.predicted_label_name === 'Deny';
  const factors = (result.top_factors || []).slice(0, 3);

  if (!factors.length) {
    return isDeny
      ? 'This claim was flagged as unusual based on the overall pattern of the submitted information.'
      : 'This claim matched the typical pattern of routine, low-risk claims.';
  }

  const clauses = factors.map((factor) => {
    const name = readableFeatureName(factor.feature).toLowerCase();
    return `${name} contributed to the model's assessment`;
  });

  let clauseText;

  if (clauses.length === 1) {
    clauseText = clauses[0];
  } else if (clauses.length === 2) {
    clauseText = `${clauses[0]}, and ${clauses[1]}`;
  } else {
    clauseText = `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
  }

  return `The model's assessment was influenced by ${clauseText}. This explanation describes model associations and does not establish that a claim is valid or invalid.`;
}

function buildPlainRecourse(recourse) {
  if (!recourse) return '';
  if (recourse.error) {
    return 'Suggestions for this claim are temporarily unavailable.';
  }
  if (recourse.applicable === false) {
    return 'No changes are applicable to this claim.';
  }

  const counterfactuals = recourse.counterfactuals || [];

  if (!counterfactuals.length) {
    return 'The system did not return specific suggestions for this claim.';
  }

  const parts = counterfactuals.map((counterfactual, index) => {
    const changes = (counterfactual.changes || [])
      .map(
        (change) =>
          `${readableFeatureName(change.feature)} changing from ${change.from_value} to ${change.to_value}`
      )
      .join(', ');

    return `Option ${index + 1}: ${changes || 'Review the suggested alternative.'}`;
  });

  return `Potential model-generated alternatives for review: ${parts.join(' — ')}. These are suggestions for human review, not guarantees of approval.`;
}

function App() {
  const [form, setForm] = useState(initialForm);
  const [result, setResult] = useState(null);
  const [recourse, setRecourse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragActive, setDragActive] = useState(false);

  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const toggleCondition = (key) => {
    setForm((current) => ({
      ...current,
      conditions: {
        ...current.conditions,
        [key]: !current.conditions[key],
      },
    }));
  };

  const processFile = async (file) => {
    if (!file) return;

    const allowedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ];

    if (!allowedTypes.includes(file.type)) {
      setError('Please upload a PDF, JPG, PNG, or WebP document.');
      return;
    }

    set('document', file);
    set('extractedCost', null);
    set('extractedDays', null);
    set('needsManualFallback', false);
    setError(null);

    if (file.type === 'application/pdf' && window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

      const { cost, days } = await extractFromPdf(file);

      setForm((current) => ({
        ...current,
        extractedCost: cost,
        extractedDays: days,
        needsManualFallback: cost === null && days === null,
      }));
    } else {
      set('needsManualFallback', true);
    }
  };

  const handleFileChange = (event) => {
    processFile(event.target.files?.[0]);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    processFile(event.dataTransfer.files?.[0]);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setRecourse(null);

    try {
      // Only the model's expected features are created here.
      const features = estimateClaimFeatures(form);

      // Keep identifiers separate from the 44 model features.
      const payload = {
        ...features,
        patient_id: form.patientId.trim(),
        claim_id: form.claimId.trim(),
      };

      const response = await axios.post(`${API_BASE}/predict`, payload);
      setResult(response.data);

      if (response.data.predicted_label_name === 'Deny') {
        try {
          const recourseResponse = await axios.post(
            `${API_BASE}/recourse`,
            features
          );
          setRecourse(recourseResponse.data);
        } catch (recourseError) {
          console.error('Recourse request failed:', recourseError);
          setRecourse({ error: true });
        }
      }
    } catch (requestError) {
      console.error('Prediction request failed:', requestError);

      const detail = requestError.response?.data?.detail;
      setError(
        Array.isArray(detail)
          ? detail.map((item) => item.msg).join(', ')
          : typeof detail === 'string'
            ? detail
            : 'We could not reach the claim service. Check the backend and request fields.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="masthead">
        <span className="wordmark">HealthAudit</span>
        <p className="tagline">
          A clear, explainable look at how your claim is reviewed
        </p>
      </header>

      <form className="claim-form" onSubmit={handleSubmit}>
        <section className="form-section">
          <h2>About you</h2>
          <p className="section-hint">
            Enter identifiers to distinguish each patient and claim.
          </p>

          <div className="field-row">
            <label>
              Patient ID
              <input
                type="text"
                value={form.patientId}
                onChange={(event) => set('patientId', event.target.value)}
                placeholder="e.g. PAT-1001"
                autoComplete="off"
                required
              />
            </label>

            <label>
              Claim ID
              <input
                type="text"
                value={form.claimId}
                onChange={(event) => set('claimId', event.target.value)}
                placeholder="e.g. CLM-2026-001"
                autoComplete="off"
                required
              />
            </label>
          </div>

          <div className="field-row">
            <label>
              Full name
              <input
                type="text"
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
                autoComplete="name"
                required
              />
            </label>

            <label className="field-narrow">
              Age
              <input
                type="number"
                min="0"
                max="120"
                value={form.age}
                onChange={(event) => set('age', event.target.value)}
                required
              />
            </label>

            <label className="field-narrow">
              Sex
              <select
                value={form.sex}
                onChange={(event) => set('sex', event.target.value)}
              >
                <option value="1">Male</option>
                <option value="2">Female</option>
              </select>
            </label>
          </div>
        </section>

        <section className="form-section">
          <h2>Do you have any of these conditions?</h2>
          <p className="section-hint">Select all that apply.</p>

          <div className="pill-grid">
            {CONDITIONS.map((condition) => (
              <label
                key={condition.key}
                className={`pill ${
                  form.conditions[condition.key] ? 'pill-active' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={!!form.conditions[condition.key]}
                  onChange={() => toggleCondition(condition.key)}
                />
                {condition.label}
              </label>
            ))}
          </div>
        </section>

        <section className="form-section">
          <h2>Supporting document</h2>
          <p className="section-hint">
            Upload a medical bill, discharge summary, or prescription. PDF text
            extraction is a basic demo and may not read every document
            accurately.
          </p>

          <label
            className={`dropzone ${dragActive ? 'dropzone-active' : ''} ${
              form.document ? 'dropzone-filled' : ''
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              hidden
            />

            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path
                d="M12 3v12m0-12 4 4m-4-4-4 4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            <span>
              {form.document
                ? form.document.name
                : 'Drag a file here, or click to choose one'}
            </span>
          </label>

          {form.document &&
            !form.needsManualFallback &&
            (form.extractedCost || form.extractedDays) && (
              <p className="extracted-note">
                Figures detected —
                {form.extractedCost
                  ? ` approximate cost: $${form.extractedCost}`
                  : ''}
                {form.extractedCost && form.extractedDays ? ';' : ''}
                {form.extractedDays
                  ? ` hospital days: ${form.extractedDays}`
                  : ''}
              </p>
            )}

          {form.needsManualFallback && (
            <div className="fallback-panel">
              <p className="section-hint">
                We could not extract figures automatically. Enter estimates
                below if available.
              </p>

              <div className="field-row">
                <label>
                  Approximate medical bill ($)
                  <input
                    type="number"
                    min="0"
                    value={form.manualCost}
                    onChange={(event) =>
                      set('manualCost', event.target.value)
                    }
                  />
                </label>

                <label>
                  Days hospitalized, if any
                  <input
                    type="number"
                    min="0"
                    value={form.manualDays}
                    onChange={(event) =>
                      set('manualDays', event.target.value)
                    }
                  />
                </label>
              </div>
            </div>
          )}
        </section>

        <p className="section-hint">
          Demo notice: claim features are estimated from the form selections.
          This prototype is not suitable for real insurance decisions.
        </p>

        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Reviewing your claim…' : 'Review my claim'}
        </button>
      </form>

      {error && <p className="error-text">{String(error)}</p>}

      {result && (
        <section
          className={`result-panel ${
            result.predicted_label_name === 'Deny'
              ? 'result-deny'
              : 'result-approve'
          }`}
        >
          <div className="result-head">
            <span className="status-pill">
              {result.predicted_label_name === 'Deny'
                ? 'Denied by model'
                : 'Approved by model'}
            </span>

            <p className="routing-note">
              {result.routing === 'Final Decision'
                ? `Model confidence: ${(result.confidence * 100).toFixed(0)}%.`
                : `Referred for human review. Model confidence: ${(result.confidence * 100).toFixed(0)}%.`}
              {' '}This is a prototype result, not a real insurance determination.
            </p>
          </div>

          <div className="result-block">
            <h3>Why this result was produced</h3>
            <p>{buildPlainReason(result)}</p>
          </div>

          {result.predicted_label_name === 'Deny' && (
            <div className="result-block">
              <h3>Potential alternatives to review</h3>
              {recourse ? (
                <p>{buildPlainRecourse(recourse)}</p>
              ) : (
                <p className="muted">Loading suggestions…</p>
              )}
            </div>
          )}

          {result.decision_hash && (
            <div className="result-block">
              <h3>Blockchain verification</h3>

              <p className="hash">
                Decision ID
                <br />
                <code>{result.decision_id}</code>
              </p>

              <p className="hash">
                SHA-256 decision hash
                <br />
                <code>{result.decision_hash}</code>
              </p>

              {result.transaction_hash && (
                <>
                  <p className="hash">
                    Sepolia transaction
                    <br />
                    <code>{result.transaction_hash}</code>
                  </p>

                  <p>
                    Block number: {result.block_number ?? 'Unavailable'}
                  </p>

                  <p className="anchor-success">
                    Transaction submitted for verification.
                  </p>

                  <a
                    href={`https://sepolia.etherscan.io/tx/${result.transaction_hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Verify transaction on Etherscan ↗
                  </a>
                </>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default App;
