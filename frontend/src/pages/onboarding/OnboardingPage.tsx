/**
 * 新しく始めた直後のオンボーディング (SPEC-PASSKEY-ONBOARDING)。
 *
 *   1. 名前 (SPEC-DISPLAY-NAME-DEFERRED)
 *   1b. サービス経由で始めたなら「<サービス名> で使う情報」(spec/plan/2026-10-15-service-signup-fields-design.md §4.2)。
 *       戻り先 (?return=) からサービスを解決できたときだけ出す
 *   2. リカバリー QR のダウンロード (SPEC-RECOVERY-QR)。ダウンロードするまで次へ進めない
 *   3. PC ならスマホの追加 (SPEC-FIRST-LOGIN-PHONE-QR)。スマホなら出さない。「スマホを持っていない」で飛ばせる
 *   4. ログイン通知 (任意)
 *
 * Cernere の origin でだけ動く。埋め込み先のサービスから来た場合は、終わったら
 * /composite/login へ戻り、silent SSO で authCode を渡す (戻り先は ?return=)。
 */

import { useEffect, useState } from "react";
import { AlertTargetsPanel } from "../../components/security/AlertTargetsPanel";
import { PairingPanel } from "../../components/security/PairingPanel";
import { RecoveryCodePanel } from "../../components/security/RecoveryCodePanel";
import { bodyTextStyle, pageStyle, primaryButton, secondaryButton } from "../../components/security/panel-styles";
import { useAuth } from "../../contexts/AuthContext";
import { isMobileDevice } from "../../lib/device-kind";
import { recoveryCode, type RecoveryStatus } from "../../lib/passkey-account-api";
import { userAccess } from "../../lib/user-access-api";
import { clearPendingDisplayName, takePendingDisplayName } from "../../lib/pending-display-name";
import { getStoredUser, profile, setStoredUser } from "../../lib/api";
import { signupFieldsApi, type SignupFieldsForService } from "../../lib/signup-fields-api";
import { signalCurrentUserName } from "../../lib/webauthn-signal";
import { NameStep } from "./NameStep";
import { ServiceFieldsStep } from "./ServiceFieldsStep";
import { readReturnPath } from "./onboarding-return";

type Step = "name" | "service" | "recovery" | "phone" | "alerts";

export function OnboardingPage() {
  const { user } = useAuth();
  const returnTo = readReturnPath(window.location.search);
  const mobile = isMobileDevice();
  const [step, setStep] = useState<Step>(user?.name ? "recovery" : "name");
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // 戻り先のサービスの入力項目。checked になるまでリカバリー QR を出さない (入力を先に聞くため)。
  const [service, setService] = useState<SignupFieldsForService | null>(null);
  const [serviceChecked, setServiceChecked] = useState(false);
  const [serviceDone, setServiceDone] = useState(false);

  useEffect(() => {
    recoveryCode.status().then(setRecovery).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    signupFieldsApi.forReturn(returnTo)
      .then((result) => { if (!cancelled && result && result.fields.length > 0) setService(result); })
      // 解決できない (Cernere 単独で始めた・通信失敗) ときは出さない。サービスへ戻った後に /consent で聞かれる。
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setServiceChecked(true); });
    return () => { cancelled = true; };
  }, [returnTo]);

  // 名前の次 (= リカバリー QR の前) にサービスの入力を挟む。
  useEffect(() => {
    if (serviceChecked && service && !serviceDone && step === "recovery") setStep("service");
  }, [serviceChecked, service, serviceDone, step]);

  // 「はじめる」の前に入れた名前を保存する。失敗したら名前入力をそのまま出す。
  useEffect(() => {
    if (user?.name) return;
    const pending = takePendingDisplayName();
    if (!pending) return;
    profile.setDisplayName(pending).then(() => {
      clearPendingDisplayName();
      const stored = getStoredUser();
      if (stored) {
        setStoredUser({ ...stored, name: pending });
        void signalCurrentUserName(stored.id, pending);
      }
      setStep((current) => (current === "name" ? "recovery" : current));
    }).catch(() => { /* 名前入力で入れ直す */ });
  }, [user?.name]);

  // 許可待ちなら、サービスへ戻っても入れないので申請画面へ (許可制 案 A)。
  const finish = async () => {
    const access = await userAccess.status().catch(() => null);
    if (access && access.status !== "active") {
      window.location.assign(`/access?${new URLSearchParams({ return: returnTo }).toString()}`);
      return;
    }
    window.location.assign(returnTo);
  };
  const afterRecovery = () => setStep(mobile ? "alerts" : "phone");

  return (
    <main style={pageStyle}>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>Cernere へようこそ</h1>
      <p style={bodyTextStyle}>はじめに、いくつか設定します。</p>
      {error && <p role="alert" style={{ color: "var(--red)" }}>{error}</p>}

      {step === "name" && <NameStep onDone={() => setStep("recovery")} />}

      {step === "service" && service && (
        <ServiceFieldsStep service={service} onDone={() => { setServiceDone(true); setStep("recovery"); }} />
      )}

      {step === "recovery" && recovery && serviceChecked && (
        <>
          {recovery.hasActiveCode && !saved ? (
            <p style={bodyTextStyle}>リカバリー QR は発行済みです。</p>
          ) : (
            <RecoveryCodePanel
              withoutProof={recovery.canIssueWithoutProof}
              hasActiveCode={recovery.hasActiveCode}
              onSaved={() => setSaved(true)}
            />
          )}
          <button
            type="button"
            onClick={afterRecovery}
            disabled={!saved && !recovery.hasActiveCode}
            style={{ ...primaryButton(!saved && !recovery.hasActiveCode), marginTop: "1rem" }}
          >
            次へ
          </button>
        </>
      )}

      {step === "phone" && (
        <>
          <PairingPanel title="📱 スマホでも使えるようにする" onAdded={() => setStep("alerts")} />
          <p style={bodyTextStyle}>
            この PC のパスキーは他の端末に移せません。PC を変えたときに困らないよう、スマホのパスキーも登録しておくことをおすすめします。
          </p>
          <button type="button" onClick={() => setStep("alerts")} style={secondaryButton(false)}>
            スマホを持っていない / あとで設定する
          </button>
        </>
      )}

      {step === "alerts" && (
        <>
          <AlertTargetsPanel />
          <p style={bodyTextStyle}>通知はあとからでも「セキュリティ」画面で設定できます。</p>
          <button type="button" onClick={() => { void finish(); }} style={{ ...primaryButton(false), marginTop: "1rem" }}>
            完了
          </button>
        </>
      )}
    </main>
  );
}
