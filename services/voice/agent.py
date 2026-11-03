"""Voice service — the 911 conversation and live answers to the dispatcher.

A live call speaks through the SignalWire media bridge. Without a phone line, Muse plays the
dispatcher in an on-screen AI-to-AI call. Every answer is grounded in what the cameras show now,
and every camera handoff is announced on the same call.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from contracts import (
    CallBrief,
    CallTranscriptDelta,
    ControlEvent,
    IncidentRecord,
    ToolCallLive,
    call_brief_to_dict,
    utcnow,
)
from services.brain.call_brief import scene_facts, site_config
from services.brain.muse_client import MuseClient

from .tools import TOOL_HANDLERS, ToolName

PublishFn = Callable[[Any], Awaitable[None]]


@dataclass
class CallScriptStep:
    after_s: float
    speaker: str  # dispatcher | sentinel
    text: str = ""
    tool: ToolName | None = None


# Officer Q&A. Sentinel only speaks map/camera facts + tools.
WEAPON_SCRIPT: list[CallScriptStep] = [
    CallScriptStep(0.8, "dispatcher", "911, what's your emergency?"),
    CallScriptStep(
        0.6,
        "sentinel",
        "Armed individual with a visible firearm on camera {camera}. Location: {address}.",
    ),
    CallScriptStep(0.9, "dispatcher", "Is the person conscious? Any injuries? Names?"),
    CallScriptStep(
        0.5,
        "sentinel",
        "I cannot confirm consciousness, injury, pulse, or identity. I only report what the cameras show.",
    ),
    CallScriptStep(0.8, "dispatcher", "Give me a description of the subject."),
    CallScriptStep(0.4, "sentinel", tool="get_person_description"),
    CallScriptStep(0.7, "dispatcher", "Exact location and how long have you been tracking?"),
    CallScriptStep(0.4, "sentinel", tool="lookup_location"),
    CallScriptStep(0.4, "sentinel", tool="get_elapsed_time"),
    CallScriptStep(0.8, "dispatcher", "Direction of travel? Which camera next?"),
    CallScriptStep(
        0.5,
        "sentinel",
        "Subject last seen on {camera}. Adjacent cameras are monitored; I will update if they reappear.",
    ),
    CallScriptStep(0.8, "dispatcher", "Copy. Stay on the line for updates."),
    CallScriptStep(
        0.5,
        "sentinel",
        "Acknowledged. I will keep reporting camera handoffs.",
    ),
]


def heard(text: str) -> str:
    """Normalise whitespace for the transcript and phone audio."""
    return re.sub(r"\s{2,}", " ", text or "").strip()


def site_names() -> tuple[str, str]:
    """(spoken building name, street address) from the camera map's site block."""
    site = site_config()
    name = str(site.get("spoken_name") or site.get("name") or "the site")
    return name, str(site.get("address") or name)


def handoff_line(camera_id: str, building: str = "") -> str:
    """Spoken handoff: a place name only, never camera ids or map notes."""
    place = str(scene_facts(camera_id).get("spoken_location") or "").strip()
    if not place:
        place = f"another part of {building}" if building else "another camera view"
    return (
        f"Update: the person has moved to {place}. "
        "Campus security has been re-alerted."
    )


def count_answer(people: int, armed: int) -> str:
    """Live person count from the tracker overlay, not a static fact."""
    if people <= 0:
        return "I don't see anyone on the current camera right now."
    who = "one person" if people == 1 else f"{people} people"
    if armed <= 0:
        return f"The current camera shows {who}."
    if people == 1:
        return "The current camera shows one person, and they are armed."
    which = "one of them is" if armed == 1 else f"{armed} of them are"
    return f"The current camera shows {who}; {which} armed."


class VoiceAgent:
    """Plays officer script; accepts live whereabouts updates when subject hits cam-02/03."""

    def __init__(self, publish: PublishFn, *, muse: MuseClient | None = None) -> None:
        self.publish = publish
        # Clip clock of the camera wall (seconds); answers describe that moment.
        self.clock: Callable[[], float] = lambda: 0.0
        self._muse = muse or MuseClient()
        self._task: asyncio.Task[None] | None = None
        self._live = False
        self._incident_id: str | None = None
        self._camera = ""
        self._address = ""
        self._building = ""
        self._site_address = ""
        self._person = ""
        self._visible = True
        self._last_answer = ""
        self._unknown_answer_index = 0
        self._live_brief: CallBrief | None = None
        # camera_id -> (people, armed) from the latest overlay.boxes.
        self._counts: dict[str, tuple[int, int]] = {}
        self._update_q: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self._prev_place = ""

    def busy(self) -> bool:
        return self._live or (self._task is not None and not self._task.done())

    def active_incident_id(self) -> str | None:
        return self._incident_id if self.busy() else None

    async def start_call(
        self,
        rec: IncidentRecord,
        brief: CallBrief,
        *,
        script: list[CallScriptStep] | None = None,
    ) -> None:
        if self.busy():
            return
        self._update_q = asyncio.Queue()
        self._incident_id = rec.incident_id
        self._camera = rec.camera_id
        self._address = brief.address
        self._building, self._site_address = site_names()
        self._person = brief.person_description
        self._live_brief = brief
        self._visible = True
        self._unknown_answer_index = 0
        self._task = asyncio.create_task(
            self._run(rec, brief, script or WEAPON_SCRIPT),
            name=f"call-{rec.incident_id}",
        )

    async def start_live_call(self, rec: IncidentRecord, brief: CallBrief) -> None:
        if self.busy():
            return
        self._live = True
        self._incident_id = rec.incident_id
        self._camera = rec.camera_id
        self._building, self._site_address = site_names()
        self._address = self._site_address
        self._person = brief.person_description
        self._live_brief = brief
        self._visible = True
        self._unknown_answer_index = 0
        text = heard(
            "Hi, this is Sentinel AI, the campus camera system. "
            f"I'm reporting armed people inside {self._building}. "
            f"The address is {self._site_address}."
        )
        self._last_answer = text
        await self.publish(
            CallTranscriptDelta(
                incident_id=rec.incident_id,
                speaker="sentinel",
                text=text,
                ts=utcnow(),
            )
        )
        await self.publish(
            ControlEvent(
                action="scenario",
                scenario_id=f"security_alert:{rec.camera_id}",
                ts=utcnow(),
            )
        )

    async def start_ai_call(self, rec: IncidentRecord, brief: CallBrief, turns: int = 6) -> None:
        """No phone line wired: Muse role-plays the 911 dispatcher and Sentinel answers on screen."""
        if self.busy():
            return
        await self.start_live_call(rec, brief)
        self._task = asyncio.create_task(self._run_ai_dispatcher(rec.incident_id, turns),
                                         name=f"ai-call-{rec.incident_id}")

    async def _run_ai_dispatcher(self, incident_id: str, turns: int) -> None:
        transcript = [("sentinel", self._last_answer)]
        try:
            for _ in range(turns):
                await asyncio.sleep(2.5)
                question = await asyncio.to_thread(self._dispatcher_line, transcript)
                if not question or question.upper().startswith("END"):
                    break
                await self.publish(CallTranscriptDelta(incident_id=incident_id, speaker="dispatcher",
                                                       text=question, ts=utcnow()))
                transcript.append(("dispatcher", question))
                await asyncio.sleep(1.5)
                answer = await self.answer_dispatcher(incident_id, question)
                transcript.append(("sentinel", answer or "(no answer)"))
            await asyncio.Event().wait()  # stay on the line for camera-handoff updates
        finally:
            self._live = False
            self._incident_id = None

    def _dispatcher_line(self, transcript: list[tuple[str, str]]) -> str:
        """Next question from a Muse-played 911 dispatcher (simulation only; never a real call)."""
        z = self._muse
        convo = "\n".join(f"{who.upper()}: {text}" for who, text in transcript)
        raw = z._post_json("/v1/chat/completions", {
            "model": z.model, "max_tokens": 1500, "temperature": 0.3,
            "messages": [
                {"role": "system", "content": (
                    "You are a calm 911 dispatcher in a TRAINING SIMULATION, talking to Sentinel AI, an automated "
                    "campus camera system reporting an armed-person incident. Ask ONE short question at a time "
                    "(how many people, weapons, descriptions, where they are now, direction, injuries). Do not "
                    "repeat a question already answered. When you have enough, reply exactly END.")},
                {"role": "user", "content": f"Call so far:\n{convo}\n\nYour next line (one sentence):"}]})
        text = str((((raw.get("choices") or [{}])[0].get("message") or {}).get("content")) or "").strip()
        return text.strip('"').splitlines()[0][:200] if text else ""

    async def answer_dispatcher(self, incident_id: str, question: str) -> str:
        if not self._live or incident_id != self._incident_id:
            return "There is no active Sentinel AI call for that incident."
        facts = scene_facts(self._camera)
        facts.update(
            camera_id=self._camera,
            address=self._address,
            person_description=self._person,
        )
        if self._camera in self._counts:
            # Live tracker count replaces the static map fact.
            facts["subject_count"], facts["armed_count"] = self._counts[self._camera]
        q = question.lower()
        if q.strip(" .,!?") in {
            "ok", "okay", "copy", "got it", "understood", "thanks", "thank you"
        }:
            return ""
        if "repeat" in q or "say that again" in q:
            if "address" in q:
                answer = f"{self._site_address}."
            else:
                answer = self._last_answer
        elif "emergency" in q or "what are you reporting" in q:
            answer = f"I'm reporting an armed person at {self._building}."
        elif "address" in q or q.strip(" ?.!") == "where are you":
            answer = f"{self._site_address}."
        elif "where" in q or "location" in q:
            answer = (
                f"The person is in {facts['spoken_location']}."
                if self._visible
                and facts.get("spoken_location")
                else "I don't see the person now; this is their last confirmed camera."
            )
        elif not self._visible and any(
            word in q
            for word in (
                "weapon", "gun", "firearm", "direction", "travel", "going",
                "headed", "describe", "description", "wearing", "clothing",
                "look like",
            )
        ):
            answer = "They aren't visible, so I can't verify that now."
        elif any(word in q for word in ("weapon", "gun", "firearm")):
            answer = "The cameras show the person carrying a visible weapon."
        elif any(word in q for word in ("hurt", "injur", "medical", "conscious", "breath", "pulse")):
            answer = "I can't verify their medical condition from this camera."
        elif any(word in q for word in ("direction", "travel", "going", "headed")):
            here = facts.get("spoken_location") or "the current camera"
            answer = (
                f"They moved from {self._prev_place} to {here}."
                if self._prev_place
                else f"They're in {here}; I can't confirm their direction yet."
            )
        elif any(word in q for word in ("describe", "description", "wearing", "clothing", "look like")):
            answer = f"The person appears to be {self._person.rstrip('.').lower()}."
        elif any(word in q for word in ("how many", "count", "number of")):
            answer = count_answer(*self._counts.get(self._camera, (0, 0)))
        elif any(word in q for word in ("name", "identity", "who is", "intent", "why")):
            answer = "I can't identify the person or their intent from this footage."
        else:
            if not q.rstrip().endswith("?") and not q.lstrip().startswith(
                (
                    "what", "where", "when", "who", "how", "is ", "are ",
                    "can ", "could ", "do ", "does ", "did ", "has ", "have ",
                    "please ", "tell me",
                )
            ):
                return ""
            try:
                answer = await asyncio.to_thread(
                    self._muse.answer_dispatcher, self._frame_facts(), question
                )
            except Exception:
                answer = ""
            refusal = heard(answer).strip().lower()
            if not answer or refusal.startswith(
                ("the cameras do not confirm", "i cannot confirm", "i can't confirm")
            ):
                answers = (
                    "I don't see that on the current camera.",
                    "That isn't visible in the current camera view.",
                )
                answer = answers[self._unknown_answer_index % len(answers)]
                self._unknown_answer_index += 1
            else:
                answer = re.split(r"(?<=[.!?])\s+", answer, maxsplit=1)[0]
        answer = heard(answer)
        self._last_answer = answer
        await self.publish(
            CallTranscriptDelta(
                incident_id=incident_id,
                speaker="sentinel",
                text=answer,
                ts=utcnow(),
            )
        )
        return answer

    def _frame_facts(self) -> dict[str, Any]:
        """What the cameras show right now, for the answering model (no stored script)."""
        people, armed = self._counts.get(self._camera, (0, 0))
        mapped = scene_facts(self._camera)
        return {
            "place": self._building,
            "camera_id": self._camera,
            "location": mapped.get("spoken_location", ""),
            "visible": self._visible,
            "people": people,
            "armed": armed,
            "person_description": self._person,
        }

    def update_visual(
        self, camera_id: str, visible: bool, people: int | None = None, armed: int = 0
    ) -> None:
        """Keep live answers aligned with the latest overlay without model work."""
        self._counts[camera_id] = (int(visible) if people is None else people, armed)
        if self._live and camera_id == self._camera:
            self._visible = visible

    async def notify_whereabouts(self, camera_id: str, address: str) -> None:
        """Vision escalated the chase on another camera — update the live call."""
        if not self.busy() or not self._incident_id:
            return
        if camera_id == self._camera:
            return
        if self._live:
            await self._publish_update(camera_id, address)
        else:
            await self._update_q.put((camera_id, address))

    async def cancel(self) -> None:
        self._live = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._incident_id = None

    async def _publish_update(self, camera_id: str, address: str) -> None:
        self._prev_place = str(scene_facts(self._camera).get("spoken_location") or "")
        self._camera = camera_id
        self._address = address
        self._visible = True
        if self._live_brief is not None:
            self._live_brief.camera_id = camera_id
            self._live_brief.address = address
        report = handoff_line(camera_id, self._building)
        await self.publish(
            CallTranscriptDelta(
                incident_id=self._incident_id or "",
                speaker="sentinel",
                text=report,
                ts=utcnow(),
            )
        )
        await self.publish(
            ControlEvent(
                action="scenario",
                scenario_id=f"security_alert:{camera_id}",
                ts=utcnow(),
            )
        )

    async def _drain_updates(self, rec: IncidentRecord) -> None:
        while True:
            try:
                cam, address = self._update_q.get_nowait()
            except asyncio.QueueEmpty:
                return
            await self._publish_update(cam, address)
            await self.publish(
                ToolCallLive(
                    incident_id=rec.incident_id,
                    tool="lookup_location",
                    args={"camera_id": cam},
                    result={
                        "address": address,
                        "spoken": f"Location on file: {address}.",
                    },
                    ts=utcnow(),
                )
            )

    async def _run(
        self,
        rec: IncidentRecord,
        brief: CallBrief,
        script: list[CallScriptStep],
    ) -> None:
        ctx: dict[str, Any] = {
            "camera": rec.camera_id,
            "address": brief.address,
            "person": brief.person_description,
            "brief": brief,
            "record": rec,
            "brief_dict": call_brief_to_dict(brief),
        }
        try:
            await self.publish(
                ControlEvent(
                    action="scenario",
                    scenario_id=f"security_alert:{rec.camera_id}",
                    ts=utcnow(),
                )
            )
            for step in script:
                await self._drain_updates(rec)
                await asyncio.sleep(step.after_s)
                await self._drain_updates(rec)
                ctx["camera"] = self._camera or rec.camera_id
                ctx["address"] = self._address or brief.address
                ctx["person"] = self._person or brief.person_description
                now = utcnow()
                if step.tool:
                    handler = TOOL_HANDLERS[step.tool]
                    args, result = handler(ctx)
                    await self.publish(
                        ToolCallLive(
                            incident_id=rec.incident_id,
                            tool=step.tool,
                            args=args,
                            result=result,
                            ts=now,
                        )
                    )
                    spoken = str(result.get("spoken") or result.get("text") or "")
                    if spoken:
                        await self.publish(
                            CallTranscriptDelta(
                                incident_id=rec.incident_id,
                                speaker="sentinel",
                                text=spoken,
                                ts=utcnow(),
                            )
                        )
                    continue
                text = step.text.format(
                    camera=ctx["camera"],
                    address=ctx["address"],
                    person=ctx["person"],
                )
                await self.publish(
                    CallTranscriptDelta(
                        incident_id=rec.incident_id,
                        speaker=step.speaker,  # type: ignore[arg-type]
                        text=text,
                        ts=now,
                    )
                )
            for _ in range(20):
                await self._drain_updates(rec)
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            raise
        finally:
            self._incident_id = None
