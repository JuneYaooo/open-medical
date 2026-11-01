import { PatientTrialMatches } from "./TrialAssist";
import "./trials.css";

// 患者档案里的「可能适合的试验」：按各试验已确认的筛选条件本机判断，不经模型。
export default function PatientTrialsTab({ patient }) {
  return <section className="detail-panel trial-patient-tab" aria-label="可能适合的试验">
    <h3>可能适合的试验</h3>
    <p className="muted">对照各试验已确认的筛选条件做预筛。缺资料记为待核对，不是不符合；正式资格需在临床试验页逐项核对并由研究团队确认。</p>
    <PatientTrialMatches patientId={patient?.id} />
  </section>;
}
