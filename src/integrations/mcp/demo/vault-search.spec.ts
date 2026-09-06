import { searchVault, tokenise, type VaultNote } from './vault-search';

const notes: VaultNote[] = [
  {
    path: 'Projects/Helios.md',
    title: 'Helios',
    text: 'The billing migration is the dependency everything else pretends not to have.',
  },
  {
    path: 'Projects/Pricing.md',
    title: 'Pricing',
    text: 'Private notes on the move off seat-based pricing to usage-based billing.',
  },
  {
    path: 'Inbox/Scratch.md',
    title: 'Scratch',
    text: 'Unsorted. Most of this will not survive. Offsite agenda thoughts.',
  },
];

describe('tokenise', () => {
  it('splits wikilinks and hyphenated names into their words', () => {
    expect(tokenise('[[helios-billing]] migration')).toEqual(['helios', 'billing', 'migration']);
  });

  it('drops single characters, which carry no signal at this corpus size', () => {
    expect(tokenise('a big I query')).toEqual(['big', 'query']);
  });
});

describe('searchVault', () => {
  it('ranks the note that is actually about the query first', () => {
    const hits = searchVault(notes, 'billing migration dependency', 3);

    expect(hits[0].path).toBe('Projects/Helios.md');
  });

  it('normalises the best hit to 1, since BM25 scores compare only within a query', () => {
    const hits = searchVault(notes, 'pricing', 3);

    expect(hits[0].score).toBe(1);
    expect(hits.every((hit) => hit.score > 0 && hit.score <= 1)).toBe(true);
  });

  it('returns nothing rather than everything when no term matches', () => {
    expect(searchVault(notes, 'kubernetes bare metal', 3)).toEqual([]);
  });

  it('honours the result cap', () => {
    expect(searchVault(notes, 'notes billing pricing offsite', 2)).toHaveLength(2);
  });

  it('survives an empty vault and an empty query', () => {
    expect(searchVault([], 'anything', 3)).toEqual([]);
    expect(searchVault(notes, '   ', 3)).toEqual([]);
  });
});
