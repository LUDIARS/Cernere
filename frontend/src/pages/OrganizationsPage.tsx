import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext";
import { wsClient } from "../lib/ws-client";

interface Organization {
  id: string;
  name: string;
  slug: string;
  description: string;
  createdBy: string;
  createdAt: string;
}

interface Member {
  userId: string;
  role: string;
  joinedAt: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
}

interface PresenceEntry {
  userId: string;
  online: boolean;
}

interface PresenceEvent {
  userId: string;
  displayName: string;
  status: "online" | "offline";
  timestamp: string;
}

export function OrganizationsPage() {
  const { user, wsConnected } = useAuth();
  const isAdmin = user?.role === "admin";

  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [presence, setPresence] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newDesc, setNewDesc] = useState("");

  // Add member form
  const [showAddMember, setShowAddMember] = useState(false);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState("member");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: string; login: string; displayName: string; avatarUrl: string | null; email: string | null }>>([]);
  const [searching, setSearching] = useState(false);

  // Fetch orgs
  const fetchOrgs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await wsClient.sendCommand<Organization[]>("organization", "list");
      setOrgs(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (wsConnected) fetchOrgs();
  }, [wsConnected, fetchOrgs]);

  // Listen for presence events
  useEffect(() => {
    const unsub = wsClient.onMessage((msg) => {
      if (msg.type === "event" && msg.event === "member.presence") {
        const data = msg.payload as PresenceEvent;
        setPresence((prev) => {
          const next = new Map(prev);
          next.set(data.userId, data.status === "online");
          return next;
        });
      }
    });
    return unsub;
  }, []);

  // Select org → fetch members + presence
  const selectOrg = async (org: Organization) => {
    setSelectedOrg(org);
    setError(null);
    try {
      const [memberList, presenceList] = await Promise.all([
        wsClient.sendCommand<Member[]>("member", "list", { organizationId: org.id }),
        wsClient.sendCommand<PresenceEntry[]>("organization", "presence", { organizationId: org.id }),
      ]);
      setMembers(memberList);
      const m = new Map<string, boolean>();
      for (const p of presenceList) m.set(p.userId, p.online);
      setPresence(m);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Create org
  const handleCreate = async () => {
    setError(null);
    try {
      await wsClient.sendCommand("organization", "create", {
        name: newName, slug: newSlug, description: newDesc,
      });
      setShowCreate(false);
      setNewName(""); setNewSlug(""); setNewDesc("");
      fetchOrgs();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Search users
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (query.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const results = await wsClient.sendCommand<Array<{ id: string; login: string; displayName: string; avatarUrl: string | null; email: string | null }>>("user", "search", { query });
      // 既存メンバーを除外
      const memberIds = new Set(members.map((m) => m.userId));
      setSearchResults(results.filter((u) => !memberIds.has(u.id)));
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [members]);

  // Select user from search results
  const selectUser = (userId: string, displayName: string) => {
    setAddUserId(userId);
    setSearchQuery(displayName);
    setSearchResults([]);
  };

  // Add member
  const handleAddMember = async () => {
    if (!selectedOrg || !addUserId) return;
    setError(null);
    try {
      await wsClient.sendCommand("member", "add", {
        organizationId: selectedOrg.id,
        userId: addUserId,
        role: addRole,
      });
      setShowAddMember(false);
      setAddUserId(""); setAddRole("member"); setSearchQuery(""); setSearchResults([]);
      selectOrg(selectedOrg);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Remove member
  const handleRemoveMember = async (targetUserId: string) => {
    if (!selectedOrg) return;
    if (!confirm("このメンバーを削除しますか？")) return;
    try {
      await wsClient.sendCommand("member", "remove", {
        organizationId: selectedOrg.id,
        userId: targetUserId,
      });
      selectOrg(selectedOrg);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Update role
  const handleRoleChange = async (targetUserId: string, newRole: string) => {
    if (!selectedOrg) return;
    try {
      await wsClient.sendCommand("member", "update_role", {
        organizationId: selectedOrg.id,
        userId: targetUserId,
        role: newRole,
      });
      selectOrg(selectedOrg);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ display: "flex", height: "100%" }}>
        {/* Sidebar: org list */}
        <div style={{ width: 260, borderRight: "1px solid var(--border)", background: "var(--bg-surface)", overflow: "auto" }}>
          <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>
              My Organizations
            </span>
            {isAdmin && (
              <button className="primary" onClick={() => setShowCreate(!showCreate)} style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}>
                {showCreate ? "Cancel" : "+ Add"}
              </button>
            )}
          </div>
          {loading ? (
            <p style={{ padding: "1rem", color: "var(--text-muted)", fontSize: "0.8rem" }}>Loading...</p>
          ) : orgs.length === 0 ? (
            <p style={{ padding: "1rem", color: "var(--text-muted)", fontSize: "0.8rem" }}>
              {isAdmin ? "Create your first organization" : "No organizations yet"}
            </p>
          ) : (
            orgs.map((org) => (
              <div
                key={org.id}
                onClick={() => selectOrg(org)}
                style={{
                  padding: "0.5rem 1rem", cursor: "pointer",
                  background: selectedOrg?.id === org.id ? "var(--bg-hover, rgba(255,255,255,0.05))" : "transparent",
                }}
              >
                <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>{org.name}</div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{org.slug}</div>
              </div>
            ))
          )}
        </div>

        {/* Main */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
          {error && (
            <div style={{ padding: "0.5rem 0.75rem", marginBottom: "1rem", borderRadius: "4px", background: "rgba(248,81,73,0.1)", border: "1px solid var(--red)", fontSize: "0.85rem", color: "var(--red)" }}>
              {error}
            </div>
          )}

          {/* Create form */}
          {showCreate && isAdmin && (
            <div style={{ marginBottom: "1.5rem", padding: "1rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
              <h3 style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.75rem" }}>New Organization</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <div>
                  <label style={labelStyle}>Name</label>
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} style={inputStyle} placeholder="My Organization" />
                </div>
                <div>
                  <label style={labelStyle}>Slug</label>
                  <input value={newSlug} onChange={(e) => setNewSlug(e.target.value)} style={inputStyle} placeholder="my-org" />
                </div>
              </div>
              <div style={{ marginBottom: "0.75rem" }}>
                <label style={labelStyle}>Description</label>
                <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} style={inputStyle} placeholder="Optional" />
              </div>
              <button className="primary" onClick={handleCreate}>Create</button>
            </div>
          )}

          {/* Org detail + members */}
          {selectedOrg ? (
            <div>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 0.25rem" }}>{selectedOrg.name}</h2>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "1.5rem" }}>
                {selectedOrg.description || selectedOrg.slug}
              </div>

              {/* Members */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>Members ({members.length})</h3>
                <button onClick={() => setShowAddMember(!showAddMember)} style={{
                  fontSize: "0.8rem", padding: "0.25rem 0.5rem", borderRadius: "4px",
                  border: "1px solid var(--border)", background: "transparent", color: "var(--text)", cursor: "pointer",
                }}>{showAddMember ? "Cancel" : "+ Add Member"}</button>
              </div>

              {/* Add member form */}
              {showAddMember && (
                <div style={{ marginBottom: "1rem", padding: "0.75rem", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "4px" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
                    <div style={{ flex: 1, position: "relative" }}>
                      <label style={labelStyle}>ユーザー検索</label>
                      <input
                        value={searchQuery}
                        onChange={(e) => handleSearch(e.target.value)}
                        style={inputStyle}
                        placeholder="名前・メール・ログインIDで検索..."
                      />
                      {/* 検索結果ドロップダウン */}
                      {searchResults.length > 0 && (
                        <div style={{
                          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
                          background: "var(--bg-surface)", border: "1px solid var(--border)",
                          borderRadius: "0 0 4px 4px", maxHeight: 200, overflow: "auto",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                        }}>
                          {searchResults.map((u) => (
                            <div
                              key={u.id}
                              onClick={() => selectUser(u.id, u.displayName || u.login)}
                              style={{
                                padding: "0.5rem 0.75rem", cursor: "pointer",
                                display: "flex", alignItems: "center", gap: "0.5rem",
                                borderBottom: "1px solid var(--border)",
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover, rgba(255,255,255,0.05))")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                            >
                              {u.avatarUrl && <img src={u.avatarUrl} style={{ width: 24, height: 24, borderRadius: "50%" }} />}
                              <div>
                                <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>{u.displayName || u.login}</div>
                                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{u.email || u.login}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {searching && <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 2 }}>検索中...</div>}
                    </div>
                    <div>
                      <label style={labelStyle}>Role</label>
                      <select value={addRole} onChange={(e) => setAddRole(e.target.value)} style={{ ...inputStyle, width: 130 }}>
                        <option value="member">Member</option>
                        <option value="maintainer">Maintainer</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <button className="primary" onClick={handleAddMember} disabled={!addUserId} style={{ height: 34 }}>追加</button>
                  </div>
                  {addUserId && <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 4 }}>選択: {addUserId.slice(0, 8)}...</div>}
                </div>
              )}

              {/* Member list */}
              <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
                {members.map((m) => {
                  const online = presence.get(m.userId) ?? false;
                  const isMe = m.userId === user?.id;
                  return (
                    <div key={m.userId} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                        {/* Presence dot */}
                        <div style={{
                          width: 8, height: 8, borderRadius: "50%",
                          background: online ? "#2ea043" : "#6e7681",
                          flexShrink: 0,
                        }} />
                        <div>
                          <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                            {m.displayName || m.login}
                            {isMe && <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}> (you)</span>}
                          </div>
                          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                            {m.email ?? m.userId.slice(0, 8)}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <select
                          value={m.role}
                          onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                          disabled={isMe || m.role === "owner"}
                          style={{ fontSize: "0.75rem", padding: "0.15rem 0.4rem", borderRadius: "3px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
                        >
                          <option value="owner">Owner</option>
                          <option value="admin">Admin</option>
                          <option value="maintainer">Maintainer</option>
                          <option value="member">Member</option>
                        </select>
                        {!isMe && m.role !== "owner" && (
                          <button onClick={() => handleRemoveMember(m.userId)} style={{
                            fontSize: "0.7rem", padding: "0.15rem 0.4rem", borderRadius: "3px",
                            border: "1px solid var(--red)", background: "transparent", color: "var(--red)", cursor: "pointer",
                          }}>Remove</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)" }}>
              Select an organization
            </div>
          )}
        </div>
      </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.2rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "0.4rem 0.5rem", borderRadius: "4px",
  border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)",
  fontSize: "0.85rem", boxSizing: "border-box" as const,
};
