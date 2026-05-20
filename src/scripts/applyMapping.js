import { readFile, writeFile } from 'node:fs/promises';

const STATE_PATH = 'data/shopify-state.json';
const REVIEW_MD = 'data/AMBIGUOUS_REVIEW.md';

function isCheckedRow(rowText) {
    // First cell of the row contains the checkbox. Accept "[x]", "[X]", "[ x]", "[x ]",
    // "[ X ]" etc. — markdown formatters can add whitespace inside the brackets.
    const firstCell = rowText.slice(rowText.indexOf('|') + 1, rowText.indexOf('|', rowText.indexOf('|') + 1));
    return /\[\s*[xX]\s*\]/.test(firstCell);
}

function extractAdminGid(rowText) {
    const match = rowText.match(/admin\/products\/(\d+)/);
    return match ? `gid://shopify/Product/${match[1]}` : null;
}

function extractSourceHandle(headingLine) {
    // `### handle — _"Title"_` — handle is the first whitespace-delimited token after `### `
    const match = headingLine.match(/^###\s+(\S+)\s+—/);
    return match ? match[1] : null;
}

async function main() {
    const markdown = await readFile(REVIEW_MD, 'utf8');
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8'));

    const sections = markdown.split(/^### /m).slice(1);
    let entriesProcessed = 0;
    let appliedCount = 0;
    let unchanged = 0;
    let multiplePicks = 0;

    for (const sectionBody of sections) {
        const lines = sectionBody.split('\n');
        const headingLine = `### ${lines[0]}`;
        const sourceHandle = extractSourceHandle(headingLine);
        if (!sourceHandle) continue;
        entriesProcessed += 1;
        const checkedRows = lines.filter(
            (line) => line.startsWith('|') && /\[\s*[xX]\s*\]/.test(line),
        );
        if (!checkedRows.length) {
            unchanged += 1;
            continue;
        }
        if (checkedRows.length > 1) multiplePicks += 1;
        const firstChecked = checkedRows[0];
        const pickedGid = extractAdminGid(firstChecked);
        if (!pickedGid) {
            console.warn(`Could not extract product GID from row in ${sourceHandle}: ${firstChecked.slice(0, 120)}`);
            continue;
        }
        state.productResolutions[sourceHandle] = {
            gid: pickedGid,
            matchedBy: 'manual',
            title: null,
        };
        appliedCount += 1;
        console.log(`  ✓ ${sourceHandle} → ${pickedGid}`);
    }

    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    console.log('');
    console.log(`Entries processed:   ${entriesProcessed}`);
    console.log(`Manually applied:    ${appliedCount}`);
    console.log(`Left unchanged:      ${unchanged}`);
    if (multiplePicks) console.log(`Multiple picks (used first): ${multiplePicks}`);
    console.log('Now re-run: npm run import -- articles && npm run import -- recipes && npm run import -- herbarium');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
