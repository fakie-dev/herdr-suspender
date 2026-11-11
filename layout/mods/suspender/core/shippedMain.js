// Herdr 0.1.14's own layouts/main.json, as it ships. The living layout is built
// from it once, on load, only when there is none yet: `herdr-app check` (which
// installing the mod runs) loads the module but lets no read finish, and a
// write started at once is all that lands. The first copy that shows rebuilds
// the layout from the main.json the person really has.
export const SHIPPED_MAIN_VERSION = "0.1.14";
export const SHIPPED_MAIN = {
    id: "root",
    type: "row",
    titlebar: "none",
    traffic_lights: [12, 16],
    background: "canvas",
    terminal_padding: [14, 12],
    divider: {
        width: 1,
        color: "border",
    },
    children: [
        {
            id: "sidebar",
            type: "column",
            size: {
                px: 268,
            },
            min: 44,
            max: 480,
            background: "chrome",
            resizable: false,
            children: [
                {
                    id: "brand",
                    type: "block",
                    size: {
                        px: 46,
                    },
                    window_drag: true,
                    content: {
                        mod: "workspace-chrome",
                    },
                },
                {
                    id: "sidebar-lists",
                    type: "column",
                    children: [
                        {
                            id: "spaces",
                            type: "block",
                            size: {
                                weight: 1,
                            },
                            min: 90,
                            content: {
                                mod: "spaces",
                            },
                        },
                        {
                            id: "agents",
                            type: "block",
                            size: {
                                weight: 1,
                            },
                            min: 90,
                            content: {
                                mod: "agents",
                            },
                        },
                    ],
                },
                {
                    id: "sidebar-footer",
                    type: "block",
                    size: {
                        px: 69,
                    },
                    content: {
                        mod: "workspace-chrome",
                        props: {
                            footer: true,
                        },
                    },
                },
            ],
        },
        {
            id: "work",
            type: "column",
            resizable: false,
            children: [
                {
                    id: "tabs",
                    type: "block",
                    size: {
                        px: 42,
                    },
                    window_drag: true,
                    content: {
                        mod: "tabs",
                    },
                },
                {
                    id: "work-body",
                    type: "row",
                    padding: 8,
                    gap: 8,
                    children: [
                        {
                            id: "main",
                            type: "block",
                            content: {
                                tab: "active",
                                pane: {
                                    gap: 8,
                                    radius: 10,
                                    background: "background",
                                    lone: true,
                                    border: {
                                        width: 1,
                                        color: "border",
                                    },
                                    focus: {
                                        width: 1,
                                        color: "accent",
                                    },
                                    header: {
                                        content: {
                                            mod: "pane",
                                        },
                                        height: 30,
                                        position: "top",
                                        reveal: "always",
                                    },
                                },
                            },
                        },
                        {
                            id: "panel",
                            type: "column",
                            hidden: true,
                            size: {
                                px: 368,
                            },
                            min: 280,
                            max: 900,
                            children: [
                                {
                                    id: "panel-body",
                                    type: "stack",
                                    active: "files",
                                    children: [
                                        {
                                            id: "files",
                                            type: "block",
                                            content: {
                                                mod: "files",
                                            },
                                        },
                                        {
                                            id: "changes",
                                            type: "block",
                                            content: {
                                                mod: "changes",
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                {
                    id: "status",
                    type: "block",
                    size: {
                        px: 28,
                    },
                    content: {
                        mod: "workspace-status",
                    },
                },
            ],
        },
    ],
};
