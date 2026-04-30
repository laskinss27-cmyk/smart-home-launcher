import React, { useEffect, useRef, useState } from "react";
import logo from "./logo.png";
import type { ModuleInfo, UpdateInfo } from "./api";

type LogLine = { id: string; msg: string; t: number };

export function App() {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  const [updates, setUpdates] = useState<Record<string, UpdateInfo>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = async () => setModules(await window.api.list());

  useEffect(() => {
    refresh();
    const offLog = window.api.onLog(({ id, msg }) =>
      setLogs((prev) => [...prev.slice(-400), { id, msg, t: Date.now() }])
    );
    const offChange = window.api.onChange(setModules);
    checkUpdates();
    const interval = setInterval(checkUpdates, 5 * 60 * 1000);
    return () => { offLog(); offChange(); clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const checkUpdates = async () => {
    try { setUpdates(await window.api.check()); } catch {}
  };

  const setBusyFor = (id: string, v: boolean) =>
    setBusy((b) => ({ ...b, [id]: v }));

  const handleInstall = async (id: string, force = false) => {
    setBusyFor(id, true);
    try { await window.api.install(id, force); await checkUpdates(); }
    catch (e: any) { setLogs((p) => [...p, { id, msg: `Ошибка: ${e.message}`, t: Date.now() }]); }
    finally { setBusyFor(id, false); refresh(); }
  };

  const handleLaunch = async (id: string) => {
    setBusyFor(id, true);
    try { await window.api.launch(id); }
    catch (e: any) { setLogs((p) => [...p, { id, msg: `Ошибка: ${e.message}`, t: Date.now() }]); }
    finally { setBusyFor(id, false); refresh(); }
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo">
          <img src={logo} alt="logo" />
          <div>
            <div className="title">УМНЫЙ ДОМ</div>
            <div className="sub">Launcher v1.0</div>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={checkUpdates}>Проверить обновления</button>
      </div>

      <div className="main">
        <div className="cards">
          {modules.map((m) => {
            const u = updates[m.id];
            const isBusy = !!busy[m.id];
            const needsInstall = !m.installed;
            const hasUpdate = u?.updateAvailable;
            return (
              <div key={m.id} className="card">
                <div
                  className="gradient"
                  style={{
                    background: `linear-gradient(135deg, ${m.gradient[0]} 0%, ${m.gradient[1]} 100%)`,
                  }}
                />
                <div>
                  {m.running && <span className="badge run">Запущено</span>}
                  {hasUpdate && !m.running && <span className="badge update">Доступно обновление</span>}
                  <h3 className="name">{m.name}</h3>
                  <p className="desc">{m.description}</p>
                </div>
                <div className="actions">
                  {needsInstall ? (
                    <button className="card-btn primary" disabled={isBusy} onClick={() => handleInstall(m.id)}>
                      {isBusy ? "Установка…" : "Установить"}
                    </button>
                  ) : (
                    <>
                      <button className="card-btn primary" disabled={isBusy || m.running} onClick={() => handleLaunch(m.id)}>
                        {m.running ? "Работает" : "Запустить"}
                      </button>
                      {hasUpdate && (
                        <button className="card-btn" disabled={isBusy} onClick={() => handleInstall(m.id, true)}>
                          {isBusy ? "Обновление…" : "Обновить"}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="console">
          <div className="head">
            <span>Журнал</span>
            <button className="btn" onClick={() => setLogs([])}>Очистить</button>
          </div>
          <div className="body" ref={logRef}>
            {logs.length === 0 && <div style={{ color: "#525a70" }}>Пусто</div>}
            {logs.map((l, i) => (
              <div className="line" key={i}>
                <span className="id">[{l.id}]</span>{l.msg}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
