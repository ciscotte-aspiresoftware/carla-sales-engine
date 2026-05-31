// /api/email-templates/* - CRUD for the per-portfolio-company email
// templates that drive Email Generation. Mirrors the shape + behaviour
// of /api/icps so the frontend can use the same patterns it does for
// ICPs (list view + edit panel + save).
//
//   GET    /api/email-templates                     - list (trimmed for picker)
//   GET    /api/email-templates/:id                 - single full record
//   POST   /api/email-templates                     - create
//   PUT    /api/email-templates/:id                 - update (id immutable)
//   DELETE /api/email-templates/:id                 - delete
//
// Optional filter on list: ?portfolioCompany=<name> narrows the result
// to one portfolio company's templates. Used by the Email Gen picker
// when scoped to a workspace.

const express = require('express');
const {
    getTemplate,
    listTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    suggestTemplate,
} = require('../utils/email-templates');

const router = express.Router();

router.get('/', (req, res) => {
    const pc = req.query.portfolioCompany || null;
    res.json({ success: true, templates: listTemplates({ portfolioCompany: pc }) });
});

// GET /api/email-templates/suggest - auto-pick a template for a given
// ICP. Used by the Email Gen page on the skip-classify flow so the rep
// lands with the right template pre-selected for the ICP they came in
// with. portfolioCompany is accepted as a soft fallback for cases where
// the ICP doesn't have its own template bound yet.
router.get('/suggest', (req, res) => {
    const icpId = req.query.icp || null;
    const portfolioCompany = req.query.portfolioCompany || null;
    const template = suggestTemplate({ icpId, portfolioCompany });
    if (!template) return res.json({ success: true, template: null });
    res.json({ success: true, template });
});

router.get('/:id', (req, res) => {
    const tpl = getTemplate(req.params.id);
    if (!tpl) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, template: tpl });
});

router.post('/', (req, res) => {
    try {
        const tpl = createTemplate(req.body || {});
        console.log(`[Templates] ✓ CREATE id="${tpl.id}" name="${tpl.name}" portfolioCompany="${tpl.portfolioCompany}" icps=[${(tpl.defaultForIcps || []).join(', ')}] language=${tpl.language}`);
        res.json({ success: true, template: tpl });
    } catch (err) {
        console.warn(`[Templates] ✗ CREATE failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.put('/:id', (req, res) => {
    try {
        const tpl = updateTemplate(req.params.id, req.body || {});
        if (!tpl) {
            console.warn(`[Templates] ✗ UPDATE id="${req.params.id}" not found`);
            return res.status(404).json({ success: false, error: 'not found' });
        }
        console.log(`[Templates] ✓ UPDATE id="${tpl.id}" name="${tpl.name}" portfolioCompany="${tpl.portfolioCompany}" icps=[${(tpl.defaultForIcps || []).join(', ')}] language=${tpl.language}`);
        res.json({ success: true, template: tpl });
    } catch (err) {
        console.warn(`[Templates] ✗ UPDATE id="${req.params.id}" failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    const ok = deleteTemplate(req.params.id);
    if (!ok) {
        console.warn(`[Templates] ✗ DELETE id="${req.params.id}" not found`);
        return res.status(404).json({ success: false, error: 'not found' });
    }
    console.log(`[Templates] ✓ DELETE id="${req.params.id}"`);
    res.json({ success: true });
});

module.exports = router;
