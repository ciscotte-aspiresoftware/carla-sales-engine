"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { api } from "@/lib/api"
import type { EmailSequence, OutreachSender, Pack } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChevronLeft, CheckCircle2, XCircle, CheckCheck, XOctagon,
  Mail, User, Zap, Brain, Send, Pencil, Save, X, Globe, ExternalLink,
} from "lucide-react"
import { cn } from "@/lib/utils"

function groupByProspect(sequences: EmailSequence[]) {
  const groups: Record<number, EmailSequence[]> = {}
  for (const seq of sequences) {
    if (!groups[seq.prospect_id]) groups[seq.prospect_id] = []
    groups[seq.prospect_id].push(seq)
  }
  return groups
}

const STATUS_BADGE: Record<string, string> = {
  pending:  "bg-amber-900/40 text-amber-400 border-amber-800",
  approved: "bg-emerald-900/40 text-emerald-400 border-emerald-800",
  rejected: "bg-red-900/40 text-red-400 border-red-800",
}

function deriveSender(pack: Pack | null): OutreachSender {
  // Layered packs put the sender on vendor; legacy packs put it at the top level.
  // Fall back to a sender derived from the product / display name so nothing breaks.
  type LayeredPack = Pack & { vendor?: { outreach_sender?: OutreachSender } }
  const layered = pack as LayeredPack | null
  const sender = layered?.vendor?.outreach_sender ?? pack?.outreach_sender
  if (sender?.name && sender?.email) return sender
  const productName = pack?.product_name || pack?.display_name || "Sales"
  return {
    name: `The ${productName} Team`,
    email: "outreach@example.com",
  }
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>()
  const [sequences, setSequences] = useState<EmailSequence[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<EmailSequence | null>(null)
  const [acting, setActing] = useState<Record<number, boolean>>({})
  const [bulkApproving, setBulkApproving] = useState(false)
  const [bulkRejecting, setBulkRejecting] = useState(false)
  const [bulkSending, setBulkSending] = useState(false)
  const [sender, setSender] = useState<OutreachSender>({
    name: "The Sales Team",
    email: "outreach@example.com",
  })

  // Edit state
  const [editing, setEditing] = useState(false)
  const [editSubject, setEditSubject] = useState("")
  const [editBody, setEditBody] = useState("")
  const [saving, setSaving] = useState(false)

  const load = () => {
    api.getSequences({ campaign_id: Number(id) })
      .then((r) => {
        setSequences(r.sequences)
        if (!selected && r.sequences.length > 0) {
          setSelected(r.sequences.find((s) => s.approval_status === "pending") ?? r.sequences[0])
        }
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [id])

  // Load the campaign's pack chain so the From line can come from the active vendor / pack
  // instead of being hardcoded to one product.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const campaign = await api.getCampaign(Number(id))
        const composed = await api.getComposedPack(
          campaign.vertical_pack,
          campaign.vendor_pack ?? undefined,
          campaign.product_pack ?? undefined,
        )
        if (!cancelled) setSender(deriveSender(composed))
      } catch {
        // Fall back to the default sender already in state.
      }
    })()
    return () => { cancelled = true }
  }, [id])

  const sync = (updated: EmailSequence) => {
    setSequences((prev) => prev.map((s) => s.id === updated.id ? updated : s))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const approve = async (seq: EmailSequence) => {
    setActing((a) => ({ ...a, [seq.id]: true }))
    sync(await api.approveSequence(seq.id))
    setActing((a) => ({ ...a, [seq.id]: false }))
  }

  const reject = async (seq: EmailSequence) => {
    setActing((a) => ({ ...a, [seq.id]: true }))
    sync(await api.rejectSequence(seq.id))
    setActing((a) => ({ ...a, [seq.id]: false }))
  }

  const markSent = async (seq: EmailSequence) => {
    setActing((a) => ({ ...a, [seq.id]: true }))
    sync(await api.markSent(seq.id))
    setActing((a) => ({ ...a, [seq.id]: false }))
  }

  const bulkApprove = async () => {
    const pendingIds = sequences.filter((s) => s.approval_status === "pending").map((s) => s.id)
    if (!pendingIds.length) return
    setBulkApproving(true)
    await api.bulkApprove(pendingIds)
    load()
    setBulkApproving(false)
  }

  const bulkReject = async () => {
    const pendingIds = sequences.filter((s) => s.approval_status === "pending").map((s) => s.id)
    if (!pendingIds.length) return
    setBulkRejecting(true)
    await api.bulkReject(pendingIds)
    load()
    setBulkRejecting(false)
  }

  const bulkSend = async () => {
    const toSend = sequences.filter((s) => s.approval_status === "approved" && !s.sent_at)
    if (!toSend.length) return
    setBulkSending(true)
    await Promise.all(toSend.map((s) => api.markSent(s.id)))
    load()
    setBulkSending(false)
  }

  const startEdit = () => {
    if (!selected) return
    setEditSubject(selected.subject)
    setEditBody(selected.body)
    setEditing(true)
  }

  const cancelEdit = () => setEditing(false)

  const saveEdit = async () => {
    if (!selected) return
    setSaving(true)
    const updated = await api.updateSequenceContent(selected.id, editSubject, editBody)
    sync(updated)
    setEditing(false)
    setSaving(false)
  }

  const pendingCount      = sequences.filter((s) => s.approval_status === "pending").length
  const approvedNotSent   = sequences.filter((s) => s.approval_status === "approved" && !s.sent_at).length
  const groups = groupByProspect(sequences)
  const prospectIds = Object.keys(groups).map(Number)

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 bg-gray-900 shrink-0">
        <div className="flex items-center gap-3">
          <Link href={`/campaigns/${id}`}>
            <Button variant="ghost" size="sm" className="text-gray-400 -ml-2">
              <ChevronLeft className="w-4 h-4" /> Campaign
            </Button>
          </Link>
          <div className="text-sm font-medium text-white">Email Review</div>
          <Badge className="text-[10px] bg-amber-900/40 text-amber-400 border-amber-800 border">
            {pendingCount} pending
          </Badge>
        </div>
        <div className="flex gap-2">
          {pendingCount > 0 && (
            <>
              <Button
                size="sm" onClick={bulkReject} disabled={bulkRejecting || bulkApproving || bulkSending}
                variant="outline"
                className="border-red-900 text-red-400 hover:bg-red-950 text-xs"
              >
                <XOctagon className="w-3.5 h-3.5 mr-1.5" />
                {bulkRejecting ? "Rejecting..." : `Reject All ${pendingCount}`}
              </Button>
              <Button
                size="sm" onClick={bulkApprove} disabled={bulkApproving || bulkRejecting || bulkSending}
                className="bg-emerald-600 hover:bg-emerald-500 text-xs"
              >
                <CheckCheck className="w-3.5 h-3.5 mr-1.5" />
                {bulkApproving ? "Approving..." : `Approve All ${pendingCount}`}
              </Button>
            </>
          )}
          {approvedNotSent > 0 && (
            <Button
              size="sm" onClick={bulkSend} disabled={bulkSending || bulkApproving || bulkRejecting}
              className="bg-sky-600 hover:bg-sky-500 text-xs"
            >
              <Send className="w-3.5 h-3.5 mr-1.5" />
              {bulkSending ? "Sending..." : `Send ${approvedNotSent} Approved Email${approvedNotSent !== 1 ? "s" : ""}`}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="p-5 space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 bg-gray-800 rounded" />)}
        </div>
      ) : sequences.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
          No email sequences yet. Run the AI pipeline on this campaign first.
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Approval Queue */}
          <div className="w-72 border-r border-gray-800 overflow-y-auto shrink-0 bg-gray-950">
            {prospectIds.map((pid) => {
              const seqs = groups[pid]
              const prospect = seqs[0]
              const pendingInGroup = seqs.filter((s) => s.approval_status === "pending").length
              return (
                <div key={pid} className="border-b border-gray-800">
                  <div className="px-3 py-2 bg-gray-900/50">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium text-gray-300 truncate">{prospect.business_name}</div>
                      {pendingInGroup > 0 && (
                        <span className="text-[10px] text-amber-400 ml-1 shrink-0">{pendingInGroup} pending</span>
                      )}
                    </div>
                    <div className="text-[10px] text-gray-600 truncate">{prospect.contact_name}</div>
                  </div>
                  {seqs.map((seq) => (
                    <button
                      key={seq.id}
                      onClick={() => { setSelected(seq); setEditing(false) }}
                      className={cn(
                        "w-full text-left px-3 py-2.5 hover:bg-gray-800/50 transition-colors border-t border-gray-800/50",
                        selected?.id === seq.id && "bg-sky-950/30 border-l-2 border-l-sky-500"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-gray-400">Touch {seq.touch_number}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_BADGE[seq.approval_status]}`}>
                          {seq.approval_status}
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-500 truncate mt-0.5">{seq.subject}</div>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>

          {/* Right: Email Preview */}
          <div className="flex-1 overflow-y-auto p-5">
            {selected ? (
              <div className="space-y-4 max-w-2xl">
                {/* Email Header */}
                <Card className="bg-gray-900 border-gray-800">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="text-sm font-medium text-gray-300">
                          Touch {selected.touch_number} of {groups[selected.prospect_id]?.length}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                          <User className="w-3 h-3" />
                          {selected.contact_name} · {selected.business_name}
                        </div>
                      </div>
                      <span className={`text-[11px] px-2 py-0.5 rounded border ${STATUS_BADGE[selected.approval_status]}`}>
                        {selected.approval_status}
                      </span>
                    </div>
                    <div className="space-y-1.5 text-sm">
                      <div className="flex gap-2">
                        <span className="text-gray-600 w-12 shrink-0">From:</span>
                        <span className="text-gray-300">{sender.name} &lt;{sender.email}&gt;</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-gray-600 w-12 shrink-0">To:</span>
                        <span className="text-gray-300">{selected.contact_name} &lt;{selected.contact_email}&gt;</span>
                      </div>
                      {/* Website — clickable link so the reviewer can verify
                          the email's claims against the operator's actual site
                          before approving. Opens in a new tab. */}
                      <div className="flex gap-2">
                        <span className="text-gray-600 w-12 shrink-0">Website:</span>
                        {selected.website_url ? (
                          <a
                            href={
                              /^https?:\/\//i.test(selected.website_url)
                                ? selected.website_url
                                : `https://${selected.website_url}`
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 hover:text-sky-300 inline-flex items-center gap-1 truncate"
                            title={selected.website_url}
                          >
                            <Globe className="w-3 h-3 shrink-0" />
                            <span className="truncate">{selected.website_url}</span>
                            <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
                          </a>
                        ) : (
                          <span className="text-gray-600 italic text-xs">
                            <Globe className="w-3 h-3 inline mr-1 opacity-50" />
                            no website on file
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2 items-start">
                        <span className="text-gray-600 w-12 shrink-0 mt-0.5">Subject:</span>
                        {editing ? (
                          <input
                            value={editSubject}
                            onChange={(e) => setEditSubject(e.target.value)}
                            className="flex-1 px-2 py-1 text-sm bg-gray-800 border border-sky-700 rounded text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                          />
                        ) : (
                          <span className="text-white font-medium">{selected.subject}</span>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* AI Research Notes */}
                {selected.agent_metadata && (selected.agent_metadata.hook_line || selected.agent_metadata.pain_hypothesis) && (
                  <Card className="bg-violet-950/20 border-violet-900/40">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs text-violet-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Brain className="w-3.5 h-3.5" /> What Claude researched — used to write this email
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2.5">
                      {selected.agent_metadata.hook_line && (
                        <div className="flex gap-2.5">
                          <Zap className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                          <div>
                            <div className="text-[10px] text-amber-400/70 uppercase tracking-wider mb-0.5">Hook — opening angle</div>
                            <span className="text-xs text-gray-300">{selected.agent_metadata.hook_line}</span>
                          </div>
                        </div>
                      )}
                      {selected.agent_metadata.pain_hypothesis && (
                        <div className="flex gap-2.5">
                          <Brain className="w-3.5 h-3.5 text-violet-400 mt-0.5 shrink-0" />
                          <div>
                            <div className="text-[10px] text-violet-400/70 uppercase tracking-wider mb-0.5">Pain hypothesis — core message</div>
                            <span className="text-xs text-gray-300">{selected.agent_metadata.pain_hypothesis}</span>
                          </div>
                        </div>
                      )}
                      {selected.agent_metadata.credible_detail && (
                        <div className="flex gap-2.5">
                          <Zap className="w-3.5 h-3.5 text-sky-400 mt-0.5 shrink-0" />
                          <div>
                            <div className="text-[10px] text-sky-400/70 uppercase tracking-wider mb-0.5">Credible detail — proof point used</div>
                            <span className="text-xs text-gray-300">{selected.agent_metadata.credible_detail}</span>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Email Body */}
                <Card className="bg-gray-900 border-gray-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <Mail className="w-3.5 h-3.5" /> Email Body
                      </span>
                      {!editing && !selected.sent_at && (
                        <button
                          onClick={startEdit}
                          className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-sky-400 transition-colors normal-case font-normal tracking-normal"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {editing ? (
                      <div className="space-y-3">
                        <textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          rows={12}
                          className="w-full px-3 py-3 text-sm bg-gray-800 border border-sky-700 rounded-lg text-gray-200 leading-relaxed font-sans focus:outline-none focus:ring-1 focus:ring-sky-500 resize-none"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm" onClick={saveEdit} disabled={saving}
                            className="bg-sky-600 hover:bg-sky-500 text-xs"
                          >
                            <Save className="w-3.5 h-3.5 mr-1.5" />
                            {saving ? "Saving..." : "Save Changes"}
                          </Button>
                          <Button
                            size="sm" variant="outline" onClick={cancelEdit}
                            className="border-gray-700 text-gray-400 text-xs"
                          >
                            <X className="w-3.5 h-3.5 mr-1" /> Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap font-sans bg-gray-800/30 rounded-lg p-4 border border-gray-800">
                        {selected.body}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Actions */}
                {selected.approval_status === "pending" && !editing && (
                  <div className="flex gap-3">
                    <Button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-500"
                      onClick={() => approve(selected)}
                      disabled={acting[selected.id]}
                    >
                      <CheckCircle2 className="w-4 h-4 mr-1.5" /> Approve
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1 border-red-900 text-red-400 hover:bg-red-950"
                      onClick={() => reject(selected)}
                      disabled={acting[selected.id]}
                    >
                      <XCircle className="w-4 h-4 mr-1.5" /> Reject
                    </Button>
                  </div>
                )}
                {selected.approval_status === "approved" && !selected.sent_at && (
                  <Button
                    className="w-full bg-sky-600 hover:bg-sky-500"
                    onClick={() => markSent(selected)}
                    disabled={acting[selected.id]}
                  >
                    <Send className="w-4 h-4 mr-1.5" /> Mark as Sent (Simulated)
                  </Button>
                )}
                {selected.sent_at && (
                  <div className="flex items-center gap-2 text-sm text-emerald-400 bg-emerald-950/30 border border-emerald-900/50 rounded-lg p-3">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    Sent {new Date(selected.sent_at).toLocaleDateString()}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
                Select an email from the queue to preview
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
