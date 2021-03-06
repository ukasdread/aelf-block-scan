/**
 * @file index.js
 * @author atom-yang
 * @date 2019-07-20
 */
const AElf = require('aelf-sdk');
const log4js = require('log4js');
const constants = require('./common/constants');
const Query = require('./query/index');
const Scheduler = require('./scheduler/index');
const DBBaseOperation = require('./dbOperation/index');

const defaultOptions = {
  // when chase up to last irreversible block height, start query in loop with this interval
  interval: 4000, // ms
  // the size of transactions per query
  txResultsPageSize: 100,
  // max queries in parallel
  concurrentQueryLimit: 40,
  // query from this height, include this height
  startHeight: 1,
  // If the differences between startHeight and last irreversible block height
  // is lower than heightGap, start loop just now
  // heightGap: 50,
  // missing height list, the heights you want to query and insert
  missingHeightList: [],
  // scanMode, value can be `all` or `listener`, default to be all
  scanMode: 'all',
  // listeners for scanMode: 'listener'
  listeners: [],
  // the instance of aelf-sdk
  aelfInstance: new AElf(new AElf.providers.HttpProvider('http:127.0.0.1:8000')),
  // max insert Data
  maxInsert: 200,
  // unconfirmed block buffer
  unconfirmedBlockBuffer: 60,
  // mined blocks every second
  minedSpeed: 2,
  loopCoef: 0.6,
  log4Config: {
    appenders: {
      common: {
        type: 'file',
        filename: 'common.log'
      }
    },
    categories: {
      default: { appenders: ['common'], level: 'info' }
    }
  }
};

class Scanner {
  constructor(dbOperator, options = defaultOptions) {
    this.config = {};
    this.makeConfig(dbOperator, options);
  }

  makeConfig(dbOperator, options) {
    this.currentPhase = constants.QUERY_TYPE.INIT;
    this.config = {
      ...defaultOptions,
      ...this.config,
      ...options
    };
    const {
      scanMode,
      listeners
    } = this.config;
    if (scanMode === 'listener' && Array.from(new Set(listeners.map(v => v.tag))).length < listeners.length) {
      throw new Error('duplicated listener names are not allowed');
    }
    log4js.configure(this.config.log4Config);
    this.log4Common = log4js.getLogger();
    this.config.actualConcurrentQueryLimit = this.config.concurrentQueryLimit;
    this.query = new Query({
      pageSize: this.config.txResultsPageSize,
      transLimit: this.config.concurrentQueryLimit,
      aelf: this.config.aelfInstance
    }, this.log4Common);
    this.scheduler = new Scheduler({
      interval: this.config.interval
    });
    if (!(dbOperator instanceof DBBaseOperation)) {
      throw new Error('You should give an instance of DBBaseOperation sub-class');
    }
    this.dbOperator = dbOperator;
    this.currentQueries = this.config.startHeight;
    this.lastBestHeight = null;
    this.lastLoopResult = {
      blocks: [],
      txs: []
    };
    this.loopTimes = 0;
  }

  scanPhase() {
    return this.currentPhase;
  }

  restart(dbOperator, options) {
    this.log4Common.info('restart scan');
    this.makeConfig(dbOperator, options);
    this.start();
  }

  async start() {
    this.log4Common.info('start scan');
    try {
      await this.dbOperator.init();
      this.currentPhase = constants.QUERY_TYPE.MISSING;
      await this.queryMissingHeight();
      this.currentPhase = constants.QUERY_TYPE.GAP;
      await this.queryGapHeight();
      this.currentPhase = constants.QUERY_TYPE.LOOP;
      await this.queryInLoop();
    } catch (e) {
      this.log4Common.error(e);
      this.log4Common.info('scan is shutdown due to error in program, you can restart scan or trace the error');
      this.currentPhase = constants.QUERY_TYPE.ERROR;
      this.scheduler.endTimer();
      this.dbOperator.destroy();
      throw e;
    }
  }

  async queryMissingHeight() {
    this.log4Common.info('start scan missing heights');
    for (let i = 0; i <= this.config.missingHeightList.length; i += this.config.maxInsert) {
      const heights = this.config.missingHeightList.slice(i, i + this.config.maxInsert);
      // eslint-disable-next-line no-await-in-loop
      const maxInsertResults = await this.queryBlockAndTxs(heights, constants.QUERY_TYPE.MISSING);
      // eslint-disable-next-line no-await-in-loop
      await this.dbOperator.insert(maxInsertResults);
    }
    this.log4Common.info('end scan missing heights');
  }

  async queryGapHeight() {
    this.log4Common.info('start query gap heights');
    const { LIBHeight, height: bestHeight } = await this.getHeight();
    // leave height gap for buffer
    let currentHeight = LIBHeight;
    if (currentHeight <= this.config.startHeight) {
      return;
    }
    let leftHeights = currentHeight - this.config.startHeight;
    for (let i = 0; i <= leftHeights; i += this.config.maxInsert) {
      const maxInsertHeights = new Array(this.config.maxInsert).fill(1)
        .map((value, index) => this.config.startHeight + i + index)
        // eslint-disable-next-line no-loop-func
        .filter(v => v <= currentHeight);
      // eslint-disable-next-line no-await-in-loop
      const maxInsertResults = await this.queryBlockAndTxs(maxInsertHeights, constants.QUERY_TYPE.GAP);
      maxInsertResults.LIBHeight = currentHeight;
      maxInsertResults.bestHeight = bestHeight;
      // eslint-disable-next-line no-await-in-loop
      await this.dbOperator.insert(maxInsertResults);
      // eslint-disable-next-line no-await-in-loop
      currentHeight = (await this.getHeight()).LIBHeight;
      leftHeights = currentHeight - this.config.startHeight;
    }
    this.currentQueries = currentHeight;
    this.lastBestHeight = bestHeight;
  }

  async queryInLoop() {
    this.log4Common.info('start loop');
    this.scheduler.setCallback(async () => {
      this.loopTimes++;
      this.log4Common.info(`start loop for ${this.loopTimes} time`);
      const {
        height: currentHeight,
        LIBHeight
      } = await this.getHeight();
      if (
        this.lastBestHeight
        && currentHeight - this.lastBestHeight
          <= Math.ceil(this.config.interval * this.config.minedSpeed * this.config.loopCoef / 1000)) {
        console.log('jump this loop');
        return;
      }
      const heightsLength = currentHeight - this.currentQueries || 0;
      // eslint-disable-next-line max-len
      const heights = new Array(heightsLength < 0 ? 0 : heightsLength).fill(1).map((_, index) => this.currentQueries + index + 1);
      if (this.config.scanMode === 'all') {
        const LIBHeights = heights.filter(height => height <= LIBHeight);
        const bestHeights = heights.filter(height => height > Math.max(this.lastBestHeight, LIBHeight));
        let loopHeightsResult = await this.queryBlockAndTxs([...LIBHeights, ...bestHeights], constants.QUERY_TYPE.LOOP);
        loopHeightsResult = this.mergeResult(
          loopHeightsResult,
          LIBHeights.length,
          bestHeights.length,
          LIBHeight,
          this.lastBestHeight
        );
        loopHeightsResult.LIBHeight = LIBHeight;
        loopHeightsResult.bestHeight = currentHeight;
        await this.dbOperator.insert(loopHeightsResult);
        this.lastLoopResult = loopHeightsResult;
      } else if (this.config.scanMode === 'listener') {
        const loopHeightsResult = await this.queryBlockAndTxs(heights, constants.QUERY_TYPE.LOOP);
        loopHeightsResult.LIBHeight = LIBHeight;
        loopHeightsResult.bestHeight = currentHeight;
        await this.dbOperator.insert(loopHeightsResult);
      } else {
        throw new Error('Invalid scan mode');
      }
      this.currentQueries = LIBHeight;
      this.lastBestHeight = currentHeight;
      this.log4Common.info(`end loop for ${this.loopTimes} time`);
    });
    this.scheduler.startTimer();
  }

  mergeResult(results, preHeightsLength, afterHeightsLength, LIBHeight, lastBestHeight) {
    if (this.lastLoopResult.blocks.length === 0) {
      return results;
    }
    const preResultBlocks = results.blocks.slice(0, preHeightsLength);
    const afterResultBlocks = results.blocks.slice(preHeightsLength);
    const preResultTxs = results.txs.slice(0, preHeightsLength);
    const afterResultTxs = results.txs.slice(preHeightsLength);
    const lastResultBlocks = [];
    const lastResultTxs = [];

    this.lastLoopResult.blocks.forEach((block, index) => {
      const { Header: { Height } } = block;
      if (parseInt(Height, 10) > LIBHeight && parseInt(Height, 10) <= lastBestHeight) {
        lastResultBlocks.push(block);
        lastResultTxs.push(this.lastLoopResult.txs[index]);
      }
    });
    return {
      blocks: [...preResultBlocks, ...lastResultBlocks, ...afterResultBlocks],
      txs: [...preResultTxs, ...lastResultTxs, ...afterResultTxs],
      type: results.type
    };
  }

  async getHeight() {
    this.log4Common.info('get height');
    const status = await this.query.chainStatus();
    this.log4Common
      .info(`get best height ${status.BestChainHeight}, get LIB height ${status.LastIrreversibleBlockHeight}`);
    return {
      height: parseInt(status.BestChainHeight, 10),
      LIBHeight: parseInt(status.LastIrreversibleBlockHeight, 10)
    };
  }

  async queryBlockAndTxsWithBloom(heights = [], type = 'loop') {
    const {
      listeners
    } = this.config;
    let results = [];
    for (let i = 0; i < heights.length; i += this.config.concurrentQueryLimit) {
      const heightsLimited = heights.slice(i, i + this.config.concurrentQueryLimit);
      // eslint-disable-next-line no-await-in-loop,max-len
      const blocksAndTxs = await Promise.all(heightsLimited.map(v => this.query.queryBlocksAndTxsByBloom(v, listeners)));
      results = [...results, ...blocksAndTxs];
    }
    const tags = listeners.map(v => v.tag);
    const tagsObj = tags.reduce((acc, tag) => ({
      ...acc,
      [tag]: {
        blocks: []
      }
    }), {});
    results = results.filter(v => v && v.block).reduce((acc, v) => {
      const {
        block,
        transactions
      } = v;
      const {
        scanTags
      } = block;
      // eslint-disable-next-line no-restricted-syntax
      for (const tag of scanTags) {
        acc[tag].blocks.push({
          ...block,
          transactionList: transactions.filter(tx => tx.scanTags.includes(tag))
        });
      }
      return acc;
    }, tagsObj);
    return {
      largestHeight: heights.length > 0 ? heights[heights.length - 1] : this.config.startHeight - 1,
      results,
      type
    };
  }

  async queryAllBlocksAndTxs(heights = [], type = 'loop') {
    const results = [];
    this.log4Common.info(`start query block in parallel ${this.config.concurrentQueryLimit}`);
    for (let i = 0; i < heights.length; i += this.config.concurrentQueryLimit) {
      this.log4Common.info(`start query block in parallel ${this.config.concurrentQueryLimit} for the ${i} time`);
      const heightsLimited = heights.slice(i, i + this.config.concurrentQueryLimit);
      // eslint-disable-next-line no-await-in-loop
      const txs = await Promise.all(heightsLimited.map(v => this.query.queryTransactionsByHeight(v)));
      this.log4Common.info(`end query block in parallel ${this.config.concurrentQueryLimit} for the ${i} time`);
      results.push(txs);
    }
    this.log4Common.info(`end query block in parallel ${this.config.concurrentQueryLimit}`);
    const txs = [];
    const blocks = [];
    results.reduce((acc, i) => acc.concat(i), []).forEach(({ blockInfo, transactions }) => {
      txs.push(transactions);
      blocks.push(blockInfo);
    });
    return {
      blocks,
      txs,
      type
    };
  }

  /**
   * return block information and transaction results
   * @param {Number[]} heights the array of heights
   * @param {string} type the type of query
   * @return {Promise<{blocks: *, txs: *}>}
   */
  async queryBlockAndTxs(heights = [], type = 'loop') {
    if (this.config.scanMode === 'all') {
      return this.queryAllBlocksAndTxs(heights, type);
    }
    if (this.config.scanMode === 'listener') {
      return this.queryBlockAndTxsWithBloom(heights, type);
    }
    throw new Error('Invalid scan mode');
  }
}

module.exports = {
  Scanner,
  DBBaseOperation,
  Scheduler,
  QUERY_TYPE: constants.QUERY_TYPE
};
