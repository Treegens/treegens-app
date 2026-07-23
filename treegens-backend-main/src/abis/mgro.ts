/**
 * MGRO ABI (Base deployment).
 *
 * Base MAINNET MGRO (0xe84613C7220F2cD92fD1551256f74c21e49e2283) exposes
 * `mint(address,uint256)` and gates it behind MINTER_ROLE. Older/testnet
 * deployments used `mintTokens(address,uint256)`. Both are declared here and
 * rewardMintService picks whichever the configured token actually implements.
 */
export const MGRO_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'role', type: 'bytes32' }, { internalType: 'address', name: 'account', type: 'address' }],
    name: 'hasRole',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'MINTER_ROLE',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: '_receiver', type: 'address' },
      { internalType: 'uint256', name: '_tokens', type: 'uint256' },
    ],
    name: 'mintTokens',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const
