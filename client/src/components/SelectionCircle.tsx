import { SVGProps, useEffect, useState } from "react";
import concaveman from 'concaveman';
import { createPortal } from "react-dom";

export type BBox = {
    x: number;
    y: number;
    width: number;
    height: number;
}

export const getPointsForRects = (rects: BBox[]) => {
    return rects.map(rect => {
        return [
            [rect.x, rect.y] as [number, number],
            [rect.x + rect.width, rect.y] as [number, number],
            [rect.x, rect.y + rect.height] as [number, number],
            [rect.x + rect.width, rect.y + rect.height] as [number, number]
        ];
    }).flat();
}

export const boundingBoxOfPoints = (points: [number, number][]) => {
    const minX = Math.min(...points.map(p => p[0]));
    const minY = Math.min(...points.map(p => p[1]));
    const maxX = Math.max(...points.map(p => p[0]));
    const maxY = Math.max(...points.map(p => p[1]));

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };
}

export function chaikin(points: number[][], iterations = 2) {
    let pts = points;
    for (let k = 0; k < iterations; k++) {
        const next = [];
        for (let i = 0; i < pts.length; i++) {
            const [x0, y0] = pts[i];
            const [x1, y1] = pts[(i + 1) % pts.length];
            next.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
            next.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
        }
        pts = next;
    }
    return pts;
}

/**
 * Given a set of points, return the bounding box that contains all the points.
 * @param points 
 * @returns 
 */
export const getBoundingBox = (points: [number, number][]): BBox => {
    const minX = Math.min(...points.map(p => p[0]));
    const minY = Math.min(...points.map(p => p[1]));
    const maxX = Math.max(...points.map(p => p[0]));
    const maxY = Math.max(...points.map(p => p[1]));

    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    };
};


type SelectionCircleProps = {
    elements: SVGGraphicsElement[]
} & SVGProps<SVGPathElement>

export const SelectionCircle = ({ elements, ...svgProps }: SelectionCircleProps) => {
    const [path, setPath] = useState<string>('')

    useEffect(() => {
        if (elements.length === 0) return

        const margin = 200;

        const bboxes = elements.map(el => {
            const bbox = el.getBBox()
            bbox.x -= margin
            bbox.y -= margin
            bbox.width += 2 * margin
            bbox.height += 2 * margin
            return bbox
        })

        const points = getPointsForRects(bboxes)
        const concaveHull = concaveman(points, 2)
        const smoothPoints = chaikin(concaveHull, 14);

        setPath(
            smoothPoints
                .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
                .join(' ')
                .concat(' Z')
        )
    }, [elements])

    return createPortal(
        <path
            className="hull"
            d={path}
            fill='oklch(70% 0.1 145)'
            fillOpacity={0.2}
            strokeWidth={2}
            {...svgProps}
        />,
        elements[0]?.closest('g') || document.body
    )
}
