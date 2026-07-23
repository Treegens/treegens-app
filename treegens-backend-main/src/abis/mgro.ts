/**
 * MGRO ABI (Base deployment).
 *
 * Base MAINNET MGRO (0xe84613C7220F2cD92fD1551256f74c21e49e2283) exposes
 * `mint(address,uint256)` / `burn(address,uint256)` (selectors 0x40c10f19 /
 * 0x9dc29fac, per the Basescan-verified source), gated behind MINTER_ROLE.
 * Very old deployments used `mintItem`/`burnItem`, later ones
 * `mintTokens(address,uint256)`; only `mintTokens` is kept as a fallback and
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
    inputs: [
      { internalType: 'address', name: 'from', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'burn',
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
