/**
 * サービス経由で始めた人のオンボーディング: 名前の次に「<サービス名> で使う情報」を聞く
 * (spec/plan/2026-10-15-service-signup-fields-design.md §4.2)。
 *
 * 対象サービスは戻り先 (?return=) から signup_fields.for_return で解決する (OnboardingPage が渡す)。
 * ここで必須を入れておけば、サービスへ戻った後の関門は入力の不足で止まらない。
 */

import { useState } from "react";
import { bodyTextStyle, messageStyle, panelStyle, panelTitleStyle, primaryButton } from "../../components/security/panel-styles";
import { SignupFieldsForm } from "../../components/signup-fields/SignupFieldsForm";
import {
  initialSignupValues,
  requiredFilled,
  signupFieldsApi,
  type SignupFieldErrors,
  type SignupFieldValue,
  type SignupFieldsForService,
} from "../../lib/signup-fields-api";

export function ServiceFieldsStep({ service, onDone }: { service: SignupFieldsForService; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, SignupFieldValue>>(() => initialSignupValues(service.fields));
  const [errors, setErrors] = useState<SignupFieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = requiredFilled(service.fields, values);

  const save = async () => {
    setBusy(true);
    setError("");
    setErrors({});
    try {
      const result = await signupFieldsApi.save(service.projectKey, values);
      if (!result.ok) {
        setErrors(result.fieldErrors);
        setError("入力内容を確認してください。");
        return;
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>📝 {service.serviceName} で使う情報</h2>
      <p style={bodyTextStyle}>
        {service.serviceName} を使うために必要な情報です。あとから Cernere の「サービスの権限」で直せます。
      </p>
      {error && <div role="alert" style={messageStyle(true)}>{error}</div>}
      <SignupFieldsForm
        serviceName={service.serviceName}
        fields={service.fields}
        values={values}
        errors={errors}
        disabled={busy}
        onChange={(column, value) => setValues((prev) => ({ ...prev, [column]: value }))}
      />
      <button type="button" onClick={() => { void save(); }} disabled={busy || !ready} style={primaryButton(busy || !ready)}>
        保存して次へ
      </button>
    </div>
  );
}
