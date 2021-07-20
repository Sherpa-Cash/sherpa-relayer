const Web3 = require('web3')
const { toBN, fromWei } = require('web3-utils')
const Redis = require('ioredis')

const { queue } = require('./queue')
const { getInstance, fromDecimals } = require('./utils')
const { jobType, status } = require('./constants')
const {
  netId,
  redisUrl,
  gasLimits,
  instances,
  privateKey,
  httpRpcUrl,
  tornadoServiceFee,
} = require('./config')

const { TxManager } = require('tx-manager')

let web3
let currentTx
let currentJob
let txManager
let gasPrice
const redis = new Redis(redisUrl)

async function start() {
  const { CONFIRMATIONS, MAX_GAS_PRICE } = process.env

  gasPrice = MAX_GAS_PRICE;

  try {
    web3 = new Web3(httpRpcUrl);
    txManager = new TxManager({
      privateKey,
      rpcUrl: httpRpcUrl,
      config: { CONFIRMATIONS, MAX_GAS_PRICE, THROW_ON_REVERT: false },
    })

    queue.process(processJob)
    console.log('Worker started')
  } catch (e) {
    console.error('error on start worker', e.message);
    throw e;
  }
}

async function checkTornadoFee({ args, contract }) {
  console.log('a')
  const { currency, amount } = getInstance(contract)
  console.log('b')
  const { decimals } = instances[`netId${netId}`][currency]
  const [fee, refund] = [args[4], args[5]].map(toBN)

  const expense = toBN(gasPrice).mul(toBN(gasLimits[jobType.TORNADO_WITHDRAW]))
  const feePercent = toBN(fromDecimals(amount, decimals))
    .mul(toBN(tornadoServiceFee * 1e10))
    .div(toBN(1e10 * 100))

  let desiredFee
  switch (currency) {
    case 'avax': {
      desiredFee = expense.add(feePercent)
      break
    }
    default: {
      const ethPrice = await redis.hget('prices', currency)
      desiredFee = expense
        .add(refund)
        .mul(toBN(10 ** decimals))
        .div(toBN(ethPrice))
      desiredFee = desiredFee.add(feePercent)
      break
    }
  }
  console.log(
    'sent fee, desired fee, feePercent',
    fromWei(fee.toString()),
    fromWei(desiredFee.toString()),
    fromWei(feePercent.toString()),
  )
  if (fee.lt(desiredFee)) {
    throw new Error('Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit.')
  }
}

async function getTxObject({ data }) {
  return {
    value: data.args[5],
    to: contract._address,
    data: data.contract.methods.withdraw(data.proof, ...data.args).encodeABI(),
  }
}

async function processJob(job) {
  if (job.data.type !== jobType.TORNADO_WITHDRAW) {
    throw new Error(`Unknown job type: ${job.data.type}`)
  }

  try {
    currentJob = job
    await updateStatus(status.ACCEPTED)
    console.log(`Start processing a new ${job.data.type} job #${job.id}`)
    await submitTx(job)
  } catch (e) {
    console.error('processJob', e.message)
    await updateStatus(status.FAILED)
    throw e
  }
}

async function submitTx(job, retry = 0) {
  await checkTornadoFee(job)
  currentTx = await txManager.createTx(await getTxObject(job))

  try {
    const receipt = await currentTx
      .send()
      .on('transactionHash', txHash => {
        updateTxHash(txHash)
        updateStatus(status.SENT)
      })
      .on('mined', receipt => {
        console.log('Mined in block', receipt.blockNumber)
        updateStatus(status.MINED)
      })
      .on('confirmations', updateConfirmations)

    if (receipt.status === 1) {
      await updateStatus(status.CONFIRMED)
    }
  } catch (e) {
    console.error('processJob', e.message);
    await updateStatus(status.FAILED);
    throw e;
  }
}

async function updateTxHash(txHash) {
  console.log(`A new successfully sent tx ${txHash}`)
  currentJob.data.txHash = txHash
  await currentJob.update(currentJob.data)
}

async function updateConfirmations(confirmations) {
  console.log(`Confirmations count ${confirmations}`)
  currentJob.data.confirmations = confirmations
  await currentJob.update(currentJob.data)
}

async function updateStatus(status) {
  console.log(`Job status updated ${status}`)
  currentJob.data.status = status
  await currentJob.update(currentJob.data)
}

start()
