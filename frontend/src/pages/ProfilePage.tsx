import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { profile as profileApi, type UserProfileData, type ProfilePrivacy } from "../lib/api";

export function ProfilePage() {
  const { user } = useAuth();
  const [, setData] = useState<UserProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // form state
  const [roleTitle, setRoleTitle] = useState("");
  const [bio, setBio] = useState("");
  const [expertiseText, setExpertiseText] = useState("");
  const [hobbiesText, setHobbiesText] = useState("");
  const [privacy, setPrivacy] = useState<ProfilePrivacy>({
    bio: true,
    roleTitle: true,
    expertise: true,
    hobbies: true,
  });

  useEffect(() => {
    profileApi
      .getMyProfile()
      .then((p) => {
        setData(p);
        setRoleTitle(p.roleTitle);
        setBio(p.bio);
        setExpertiseText(p.expertise.join(", "));
        setHobbiesText(p.hobbies.join(", "));
        setPrivacy(p.privacy);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage("");
    try {
      const expertise = expertiseText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const hobbies = hobbiesText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const updated = await profileApi.updateMyProfile({
        roleTitle,
        bio,
        expertise,
        hobbies,
        privacy,
      });
      setData(updated);
      setMessage("保存しました");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }, [roleTitle, bio, expertiseText, hobbiesText, privacy]);

  const togglePrivacy = (key: keyof ProfilePrivacy) => {
    setPrivacy((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <span style={{ color: "var(--text-muted)" }}>Loading...</span>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "2rem" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {/* ヘッダー */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>プロファイル設定</h1>
          <Link to="/" style={{ fontSize: "0.875rem" }}>← ダッシュボード</Link>
        </div>

        {/* ユーザー基本情報 */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "1.5rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>
            基本情報
          </h2>
          <p><strong>名前:</strong> {user?.name}</p>
          <p><strong>メール:</strong> {user?.email}</p>
          <p><strong>システムロール:</strong> <span className="badge blue">{user?.role}</span></p>
        </div>

        {/* パーソナリティデータ */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "1.5rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "1rem", color: "var(--text-muted)" }}>
            パーソナリティデータ
          </h2>

          <div className="form-group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label>役割</label>
              <PrivacyToggle
                enabled={privacy.roleTitle}
                onToggle={() => togglePrivacy("roleTitle")}
              />
            </div>
            <input
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              placeholder="例: フロントエンドエンジニア"
            />
          </div>

          <div className="form-group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label>自己紹介</label>
              <PrivacyToggle
                enabled={privacy.bio}
                onToggle={() => togglePrivacy("bio")}
              />
            </div>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              placeholder="自己紹介を書いてください"
            />
          </div>

          <div className="form-group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label>得意分野</label>
              <PrivacyToggle
                enabled={privacy.expertise}
                onToggle={() => togglePrivacy("expertise")}
              />
            </div>
            <input
              value={expertiseText}
              onChange={(e) => setExpertiseText(e.target.value)}
              placeholder="カンマ区切り: React, TypeScript, Rust"
            />
          </div>

          <div className="form-group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label>趣味</label>
              <PrivacyToggle
                enabled={privacy.hobbies}
                onToggle={() => togglePrivacy("hobbies")}
              />
            </div>
            <input
              value={hobbiesText}
              onChange={(e) => setHobbiesText(e.target.value)}
              placeholder="カンマ区切り: 読書, キャンプ, ゲーム"
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginTop: "1rem" }}>
            <button className="primary" onClick={handleSave} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </button>
            {message && (
              <span style={{ fontSize: "0.85rem", color: message.includes("失敗") ? "var(--red)" : "var(--green)" }}>
                {message}
              </span>
            )}
          </div>
        </div>

        {/* プライバシー説明 */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "1.5rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>
            プライバシーについて
          </h2>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.7 }}>
            各フィールド右側のトグルで公開 / 非公開を切り替えられます。
            非公開にしたフィールドは、他のユーザーやツールからのプロファイル参照時に表示されません。
            データ自体はサーバーに保存されますが、API レスポンスからフィルタされます。
          </p>
        </div>

        {/* データオプトアウトリンク */}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "1.5rem",
          }}
        >
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>
            データ管理
          </h2>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.7, marginBottom: "0.75rem" }}>
            データのオプトアウト（削除）を管理できます。
            オプトアウトすると該当カテゴリのデータは完全に削除されます。
          </p>
          <Link to="/data-optout">
            <button
              style={{
                fontSize: "0.85rem",
                padding: "0.4rem 1rem",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--bg-surface)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              データオプトアウト管理
            </button>
          </Link>
        </div>
      </div>
    </div>
  );
}

/** プライバシー公開・非公開トグル */
function PrivacyToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        fontSize: "0.7rem",
        padding: "0.15rem 0.5rem",
        borderRadius: "10px",
        border: `1px solid ${enabled ? "var(--green)" : "var(--text-muted)"}`,
        background: enabled ? "rgba(63, 185, 80, 0.1)" : "transparent",
        color: enabled ? "var(--green)" : "var(--text-muted)",
        cursor: "pointer",
        fontWeight: 600,
      }}
    >
      {enabled ? "公開" : "非公開"}
    </button>
  );
}
