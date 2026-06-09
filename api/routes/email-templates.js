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
// Optional filters on list:
//   ?portfolioCompany=<name>  - narrow to one portfolio company's templates
//   ?channel=email|linkedin   - narrow to one channel. Used by the templates
//                               page's Email/LinkedIn tab toggle.

const express = require('express');
const {
    getTemplate,
    listTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    suggestTemplate,
} = require('../utils/email-templates');

const { trackActivity } = require('../middleware/activity');

const router = express.Router();

router.get('/', (req, res) => {
    const pc = req.query.portfolioCompany || null;
    const channel = req.query.channel ? String(req.query.channel).toLowerCase() : null;
    res.json({ success: true, templates: listTemplates({ portfolioCompany: pc, channel }) });
});

// GET /api/email-templates/suggest - auto-pick a template for a given
// ICP. Used by the Email Gen page on the skip-classify flow so the rep
// lands with the right template pre-selected for the ICP they came in
// with. portfolioCompany is accepted as a soft fallback for cases where
// the ICP doesn't have its own template bound yet.
//
// ?channel=email|linkedin scopes the suggestion to that channel; falls
// back across channels if no match (so an ICP with only an email template
// still resolves a sensible template for the LI route during rollout).
router.get('/suggest', (req, res) => {
    const icpId = req.query.icp || null;
    const portfolioCompany = req.query.portfolioCompany || null;
    const channel = req.query.channel ? String(req.query.channel).toLowerCase() : null;
    const template = suggestTemplate({ icpId, portfolioCompany, channel });
    if (!template) return res.json({ success: true, template: null });
    res.json({ success: true, template });
});

router.get('/:id', (req, res) => {
    const tpl = getTemplate(req.params.id);
    if (!tpl) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, template: tpl });
});

router.post('/', trackActivity('template_created'), async (req, res) => {
    try {
        const tpl = await createTemplate(req.body || {});
        console.log(`[Templates] ✓ CREATE id="${tpl.id}" name="${tpl.name}" portfolioCompany="${tpl.portfolioCompany}" icps=[${(tpl.defaultForIcps || []).join(', ')}] language=${tpl.language}`);
        res.json({ success: true, template: tpl });
    } catch (err) {
        console.warn(`[Templates] ✗ CREATE failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.put('/:id', trackActivity('template_updated'), async (req, res) => {
    try {
        const tpl = await updateTemplate(req.params.id, req.body || {});
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

router.delete('/:id', trackActivity('template_deleted'), async (req, res) => {
    const ok = await deleteTemplate(req.params.id);
    if (!ok) {
        console.warn(`[Templates] ✗ DELETE id="${req.params.id}" not found`);
        return res.status(404).json({ success: false, error: 'not found' });
    }
    console.log(`[Templates] ✓ DELETE id="${req.params.id}"`);
    res.json({ success: true });
});

module.exports = router;
