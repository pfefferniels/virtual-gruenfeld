import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Options as RoughOptions } from "roughjs/bin/core"
import { SelectionCircle } from "./SelectionCircle";

type Pt = { x: number; y: number };

function dist(a: Pt, b: Pt) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
}

/** Douglas-Peucker-ish simple decimator: keep a point only if it's far enough from the last kept */
function decimate(points: Pt[], minDist = 2): Pt[] {
    if (points.length <= 2) return points;
    const out: Pt[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        if (dist(points[i], out[out.length - 1]) >= minDist) out.push(points[i]);
    }
    return out;
}

/** Chaikin corner cutting. If closed=true, it treats endpoints cyclically. */
function chaikin(points: Pt[], iterations = 2, closed = false): Pt[] {
    if (points.length < 3) return points;
    let pts = points.slice();
    for (let k = 0; k < iterations; k++) {
        const next: Pt[] = [];
        const n = pts.length;
        const last = closed ? n : n - 1;
        for (let i = 0; i < last - 1; i++) {
            const p = pts[i];
            const q = pts[(i + 1) % n];
            // 1/4 and 3/4 (classic Chaikin)
            const p1 = { x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y };
            const p2 = { x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y };
            next.push(p1, p2);
        }
        if (!closed) {
            // preserve endpoints when open
            next.unshift(pts[0]);
            next.push(pts[pts.length - 1]);
        } else {
            // connect last->first if closed
            const p = pts[last - 1];
            const q = pts[0];
            next.push(
                { x: 0.75 * p.x + 0.25 * q.x, y: 0.75 * p.y + 0.25 * q.y },
                { x: 0.25 * p.x + 0.75 * q.x, y: 0.25 * p.y + 0.75 * q.y }
            );
        }
        pts = next;
    }
    return pts;
}

/** Build an SVG path from points; closed => appends Z */
function toPathD(points: Pt[], closed = false): string {
    if (!points.length) return "";
    const cmds = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
    for (let i = 1; i < points.length; i++) {
        cmds.push(`L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`);
    }
    if (closed) cmds.push("Z");
    return cmds.join(" ");
}

export type FreehandSVGDrawerProps = {
    svgRef?: React.RefObject<SVGSVGElement>;

    /** Minimum pixel distance between accepted raw points */
    minPointDistance?: number;

    /** Chaikin iterations applied during preview */
    smoothIterations?: number;

    /** rough.js options for finalized paths */
    roughOptions?: Partial<RoughOptions> & { stroke?: string; strokeWidth?: number; fill?: string };

    /** CSS class applied to the temporary preview path */
    previewClassName?: string;

    /** Callback when a path is finished */
    onNoteSelected?: (selectedNotes: string[]) => void;
};

export function FreehandSVGDrawer({
    svgRef,
    minPointDistance = 2,
    smoothIterations = 2,
    roughOptions = { stroke: "#111827", strokeWidth: 2, roughness: 1.25, bowing: 0.9, fillStyle: "hachure" },
    previewClassName = "stroke-gray-800 fill-transparent",
    onNoteSelected,
}: FreehandSVGDrawerProps) {
    const [currentPath, setCurrentPath] = useState<string>()
    const [selectedNotes, setSelectedNotes] = useState<SVGGraphicsElement[]>([]);

    // Ensure a layering group for our content
    useEffect(() => {
        if (!svgRef?.current) return
        if (svgRef.current.querySelector('[data-freehand-layer]')) return

        const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        layer.setAttribute("data-freehand-layer", "true");
        svgRef.current.appendChild(layer);
    }, [])

    // Pointer drawing state
    const drawingRef = useRef({
        isDrawing: false,
        points: [] as Pt[],
        draftPath: null as SVGPathElement | null,
        roughGroup: null as SVGGElement | null,
    });

    // Convert client coords to SVG coords
    const clientToSvg = (svg: SVGSVGElement, clientX: number, clientY: number): Pt => {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const ctm = svg.getScreenCTM();
        const inv = ctm?.inverse();
        const sp = inv ? pt.matrixTransform(inv) : pt;
        return { x: sp.x, y: sp.y };
    };

    // Setup pointer handlers on mount
    useEffect(() => {
        const svgEl = (svgRef?.current as SVGSVGElement | null);
        if (!svgEl) return;

        // Important for touch: prevent browser panning/zooming while drawing
        svgEl.style.touchAction = "none";

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0 && e.pointerType === "mouse") return; // left button only for mouse
            svgEl.setPointerCapture(e.pointerId);
            drawingRef.current.isDrawing = true;
            drawingRef.current.points = [clientToSvg(svgEl, e.clientX, e.clientY)];
            setSelectedNotes([]);
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!drawingRef.current.isDrawing) return;
            const pts = drawingRef.current.points;
            const next = clientToSvg(svgEl, e.clientX, e.clientY);
            if (dist(next, pts[pts.length - 1]) < minPointDistance) return;
            pts.push(next);

            const processed = chaikin(decimate(pts, minPointDistance), smoothIterations, false)
            setCurrentPath(toPathD(processed, false))
        };

        const onPointerUp = (_: PointerEvent) => {
            if (!drawingRef.current.isDrawing) return;
            drawingRef.current.isDrawing = false;

            const raw = drawingRef.current.points;
            const processed = chaikin(decimate(raw, minPointDistance), smoothIterations, true)

            const finalPoints = [...processed, processed[0]];
            const d = toPathD(finalPoints, true);
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", d);
            path.setAttribute("fill", 'black');
            svgEl.querySelector('[data-freehand-layer]')?.appendChild(path);

            const notes = svgEl.querySelectorAll<SVGGraphicsElement>('.notehead use');
            const selectedNotes: SVGGraphicsElement[] = [];

            for (const note of notes) {
                const bbox = note.getBBox();
                const pLocal = new DOMPoint(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);

                const noteToScreen = note.getScreenCTM();
                const pathToScreen = path.getScreenCTM();
                if (!noteToScreen || !pathToScreen) continue;

                // note local -> screen
                const pOnScreen = pLocal.matrixTransform(noteToScreen);
                // screen -> path local
                const screenToPath = pathToScreen.inverse();
                const pInPath = pOnScreen.matrixTransform(screenToPath);

                if (path.isPointInFill(pInPath)) {
                    selectedNotes.push(note);
                }
            }

            path.remove();

            console.log('selected notes=', selectedNotes
                .map(n => {
                    const note = n.closest<SVGGElement>('.note')
                    if (!note) return
                    return note.getAttribute('id') || ''
                })
                .filter(n => n !== undefined))
            onNoteSelected?.(selectedNotes
                .map(n => {
                    const note = n.closest<SVGGElement>('.note')
                    if (!note) return
                    return note.getAttribute('id') || ''
                })
                .filter(n => n !== undefined)
            )
            setSelectedNotes(selectedNotes)
            setCurrentPath(undefined);
        };

        svgEl.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);

        return () => {
            svgEl.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
        };
    }, [svgRef, minPointDistance, smoothIterations, previewClassName, roughOptions, onNoteSelected, setCurrentPath, setSelectedNotes]);

    console.log('selected notes', selectedNotes)

    if (selectedNotes.length > 0 && svgRef) {
        return (
            <SelectionCircle
                elements={selectedNotes}
                stroke="black"
                strokeWidth={30}
                strokeDasharray={"80 40"}
                fill='oklch(70% 0.1 255)'
            />
        )
    }


    if (currentPath) {
        return createPortal(
            <path
                d={currentPath}
                fill='transparent'
                stroke='black'
                strokeWidth={2}
                strokeDasharray={"6 3"}
            />,
            svgRef?.current?.querySelector('[data-freehand-layer]')!
        )
    }

    return null;
}

