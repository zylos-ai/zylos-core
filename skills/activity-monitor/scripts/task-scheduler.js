/**
 * Unified task scheduler for Activity Monitor maintenance jobs.
 *
 * Supports date-deduped daily tasks and interval tasks. Persistence stays with
 * each task definition so existing state file formats can be preserved during
 * extraction.
 */
export class TaskScheduler {
  /**
   * @param {Array<object>} tasks
   * @param {object} deps
   * @param {function} deps.getLocalHour
   * @param {function} deps.getLocalDate
   * @param {function} [deps.nowEpoch]
   * @param {function} [deps.log]
   */
  constructor(tasks, deps) {
    this.tasks = tasks;
    this.deps = deps;
  }

  tick(snapshot = {}) {
    let executed = 0;
    for (const task of this.tasks) {
      try {
        if (this.#maybeRunTask(task, snapshot)) {
          executed++;
        }
      } catch (err) {
        this.deps.log?.(`${task.id || 'task'}: failed (${err.message})`);
      }
    }
    return executed;
  }

  #maybeRunTask(task, snapshot) {
    if (task.enabled && !task.enabled(snapshot)) return false;
    if (task.gate && !task.gate(snapshot)) return false;

    if (task.type === 'daily') {
      return this.#maybeRunDaily(task, snapshot);
    }
    if (task.type === 'interval') {
      return this.#maybeRunInterval(task, snapshot);
    }
    throw new Error(`unsupported task type: ${task.type}`);
  }

  #maybeRunDaily(task, snapshot) {
    const hour = this.deps.getLocalHour();
    if (hour !== task.hour) return false;

    const today = this.deps.getLocalDate();
    const state = task.loadState?.() ?? null;
    if (state?.last_date === today) return false;

    const ok = task.execute(snapshot) !== false;
    if (!ok) return false;

    task.writeState?.(today);
    this.deps.log?.(`${task.id}: executed (date=${today})`);
    return true;
  }

  #maybeRunInterval(task, snapshot) {
    const now = snapshot.currentTime ?? this.deps.nowEpoch?.() ?? Math.floor(Date.now() / 1000);
    const lastRunAt = task.getLastRunAt?.() ?? 0;
    if ((now - lastRunAt) < task.intervalSec) return false;

    const ok = task.execute({ ...snapshot, currentTime: now }) !== false;
    if (!ok) return false;

    task.writeState?.(now);
    this.deps.log?.(`${task.id}: executed (interval=${task.intervalSec}s)`);
    return true;
  }
}
