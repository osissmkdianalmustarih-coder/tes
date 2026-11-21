// bridge.js — Jembatan otomatis google.script.run ke /api/rpc (Vercel)
(function () {
  if (typeof window === "undefined") return;
  if (window.google && window.google.script && window.google.script.run) return;

  function createRunner(successHandler = null, failureHandler = null) {
    return new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "withSuccessHandler") {
            return (fn) => createRunner(fn, failureHandler);
          }
          if (prop === "withFailureHandler") {
            return (fn) => createRunner(successHandler, fn);
          }
          if (prop === "withUserObject") {
            return () => createRunner(successHandler, failureHandler);
          }

          // Semua panggilan fungsi seperti .submitAbsensi(payload) atau .loginAdmin(...)
          return async (...args) => {
            try {
              const response = await fetch("/api/rpc", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: String(prop),
                  args: args,
                  payload: args.length === 1 ? args[0] : args,
                }),
              });

              const result = await response.json().catch(() => ({}));

              if (!response.ok || result.ok === false || result.error) {
                throw new Error(
                  result.error || result.message || `HTTP Error ${response.status}`
                );
              }

              // Mendukung format { ok: true, data: ... } maupun respons langsung
              const output = result.data !== undefined ? result.data : result;
              if (typeof successHandler === "function") {
                successHandler(output);
              }
              return output;
            } catch (err) {
              console.error(`[bridge.js] Gagal memanggil ${String(prop)}:`, err);
              if (typeof failureHandler === "function") {
                failureHandler(err);
              }
            }
          };
        },
      }
    );
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner();
})();