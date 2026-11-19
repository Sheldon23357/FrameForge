import { estimateTokens } from './context';
import { modelExchangeLimit } from './types';
import type { ModelExchange, ModelFrame, ModelRequest } from './types';

interface ExchangeWindow {
  budgetTokens: number;
  estimatedTokens: number;
  provider: ModelRequest['provider'];
}

/** Provider history is a transport window. It is never the source of task or project state. */
export class AgentEngine {
  readonly exchanges: ModelExchange[] = [];
  private idleRounds = 0;
  private finishFailures = 0;
  private phase: 'work' | 'edit' | 'repair' | 'close' = 'work';
  private guidance = '';

  get instruction() {
    return this.guidance;
  }

  get acceptsReads() {
    return this.phase !== 'close' && this.phase !== 'edit';
  }

  beginEdit() {
    this.phase = 'edit';
    this.guidance =
      '已载入可播放路线及正文。优先用 edit_scene.insert 在已有自动出口插入过场。只有缺少节点详情时才按实际 nodeId 补查，直接使用工作区已有数据。';
  }

  inputSize(window: ExchangeWindow) {
    const latest = this.exchanges.at(-1);
    return window.provider === 'codex'
      ? estimateTokens(latest?.replies ?? []) + estimateTokens(latest?.feedback ?? '')
      : window.estimatedTokens + estimateTokens(this.exchanges);
  }

  needsNewWindow(window: ExchangeWindow) {
    if (window.provider === 'codex' || !this.exchanges.length) return false;
    return (
      this.inputSize(window) > window.budgetTokens - 8_000 ||
      this.exchanges.length >= modelExchangeLimit
    );
  }

  rebase(window: ExchangeWindow, represented: (exchange: ModelExchange) => boolean) {
    let remaining = Math.max(0, window.budgetTokens - window.estimatedTokens - 12_000);
    let from = this.exchanges.length;
    while (from > 0 && this.exchanges.length - from < 4) {
      const exchange = this.exchanges[from - 1];
      const cost = estimateTokens(exchange);
      if (cost > remaining || represented(exchange)) break;
      from--;
      remaining -= cost;
    }
    this.exchanges.splice(0, from);
  }

  retainCodexReply() {
    if (this.exchanges.length > 1) this.exchanges.splice(0, this.exchanges.length - 1);
  }

  accept(frame: ModelFrame): ModelExchange {
    return { frame, replies: [] };
  }

  repair(exchange: ModelExchange, issues: string[]) {
    if (++this.finishFailures > 2)
      throw new Error(`宿主校验未通过，修改未提交：${issues.slice(0, 3).join('；')}`);
    this.phase = 'repair';
    this.guidance = '按列出的节点 ID 修正问题，再结束。';
    exchange.feedback = `宿主校验未通过，修改尚未提交。请修复：${JSON.stringify(issues.slice(0, 25))}`;
    this.exchanges.push(exchange);
  }

  advance(exchange: ModelExchange, progress: boolean, readsOnly: boolean) {
    this.exchanges.push(exchange);
    if (progress) {
      this.idleRounds = 0;
      this.finishFailures = 0;
      if (this.phase !== 'edit' && (this.phase !== 'close' || !readsOnly)) {
        this.phase = 'work';
        this.guidance = '';
      } else if (!readsOnly) {
        this.guidance =
          '已有写入。依据当前工作区和写入回执继续补足必要的铺垫，优先用 edit_scene.insert。修改已符合当前目标时调用 check_story 校验，再明确交付已完成和剩余内容。';
      }
      return;
    }
    if (this.phase === 'close') throw new Error('连续三轮只重复读取已有信息，任务未完成。');
    if (!readsOnly) return;
    this.idleRounds++;
    this.guidance = '本次读取没有增加新信息。请使用已有材料写入、校验，或说明具体缺口。';
    if (this.idleRounds >= 2) {
      this.phase = 'close';
      this.guidance =
        '已暂停扫图和重复读取。需要缺失详情时用实际 nodeId 补查，否则现在直接写入一批可验证的修改，或交付已有结果。';
    }
  }
}
