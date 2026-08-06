--[[
* ximodels - Simple equipment model overrides for XI (Ashita v4)
*
* Type a slot + model id and the addon overlays that model on your own
* character. Model IDs only -- no file IDs, and it reads your race itself,
* so /cm equip head 3000 just means "show head model 3000".
*
* NOTE: This is a client-side visual override (same as Stylist). Other
*       players still see your real gear.
--]]

addon.name    = 'ximodels';
addon.author  = 'josh';
addon.version = '1.0';
addon.desc    = 'Override your visible equipment models by model id.';

require('common');
local chat = require('chat');
local ffi  = require('ffi');

--[[
* Slot definitions.
*   field = name of the field inside the entity Look struct (instant update)
*   o51   = byte offset of the model short in packet 0x0051 (char appearance)
*   o0A   = byte offset of the model short in packet 0x000A (zone in)
* The model block in both packets is: hair(1), race(1), then 2-byte shorts
* for Head, Body, Hands, Legs, Feet, Main, Sub, Ranged.
--]]
local slots = T{
    head  = { field = 'Head',   o51 = 0x06, o0A = 0x46 },
    body  = { field = 'Body',   o51 = 0x08, o0A = 0x48 },
    hands = { field = 'Hands',  o51 = 0x0A, o0A = 0x4A },
    legs  = { field = 'Legs',   o51 = 0x0C, o0A = 0x4C },
    feet  = { field = 'Feet',   o51 = 0x0E, o0A = 0x4E },
    main  = { field = 'Main',   o51 = 0x10, o0A = 0x50 },
    sub   = { field = 'Sub',    o51 = 0x12, o0A = 0x52 },
    range = { field = 'Ranged', o51 = 0x14, o0A = 0x54 },
};

-- Aliases so common names still work.
local aliases = T{
    hand = 'hands', arms = 'hands', leg = 'legs', foot = 'feet',
    weapon = 'main', ranged = 'range', ammo = 'range',
};

-- Active overrides: slotname -> model id (0-65535).
local overrides = T{};

local function resolve_slot(name)
    if (name == nil) then return nil; end
    name = name:lower();
    name = aliases[name] or name;
    if (slots[name] ~= nil) then return name; end
    return nil;
end

-- Push all current overrides onto the live player entity for an instant update.
local function apply_look()
    local player = GetPlayerEntity();
    if (player == nil) then return; end
    for name, id in pairs(overrides) do
        player.Look[slots[name].field] = id;
    end
    player.ModelUpdateFlags = 0x10;
end

--[[
* Prints the addon help information.
--]]
local function print_help(isError)
    if (isError) then
        print(chat.header(addon.name):append(chat.error('Invalid command syntax for command: ')):append(chat.success('/cm')));
    else
        print(chat.header(addon.name):append(chat.message('Available commands:')));
    end

    local cmds = T{
        { '/cm equip <slot> <modelid>', 'Overrides a slot with a model id (decimal or 0x hex).' },
        { '/cm reset <slot>',           'Clears the override on one slot.' },
        { '/cm reset',                  'Clears all overrides.' },
        { '/cm list',                   'Lists current overrides.' },
        { '/cm help',                   'Shows this help.' },
    };
    cmds:ieach(function (v)
        print(chat.header(addon.name):append(chat.error('Usage: ')):append(chat.message(v[1]):append(' - ')):append(chat.color1(6, v[2])));
    end);

    print(chat.header(addon.name):append(chat.color1(6, 'Slots: head, body, hands, legs, feet, main, sub, range')));
end

--[[
* event: command
--]]
ashita.events.register('command', 'command_cb', function (e)
    local args = e.command:args();
    if (#args == 0 or not args[1]:any('/cm', '/ximodels')) then
        return;
    end
    e.blocked = true;

    -- /cm  or  /cm help
    if (#args == 1 or (#args == 2 and args[2]:any('help'))) then
        print_help(false);
        return;
    end

    -- /cm list
    if (#args == 2 and args[2]:any('list')) then
        if (next(overrides) == nil) then
            print(chat.header(addon.name):append(chat.message('No active overrides.')));
            return;
        end
        print(chat.header(addon.name):append(chat.message('Active overrides:')));
        slots:each(function (_, name) -- keep a stable, readable order
            if (overrides[name] ~= nil) then
                print(chat.header(addon.name):append(chat.color1(6, ('  %-6s -> %d'):fmt(name, overrides[name]))));
            end
        end);
        return;
    end

    -- /cm reset [slot]
    if (args[2]:any('reset', 'clear', 'off')) then
        if (#args == 2) then
            overrides = T{};
            print(chat.header(addon.name):append(chat.message('Cleared all overrides. Re-equip or zone to fully refresh.')));
            return;
        end
        local slot = resolve_slot(args[3]);
        if (slot == nil) then
            print(chat.header(addon.name):append(chat.error('Unknown slot: ')):append(chat.message(args[3])));
            return;
        end
        overrides[slot] = nil;
        print(chat.header(addon.name):append(chat.message('Cleared override on: ')):append(chat.success(slot)));
        print(chat.header(addon.name):append(chat.color1(6, 'Re-equip that slot or zone to see the real model again.')));
        return;
    end

    -- /cm equip <slot> <modelid>
    if (args[2]:any('equip', 'set') and #args >= 4) then
        local slot = resolve_slot(args[3]);
        if (slot == nil) then
            print(chat.header(addon.name):append(chat.error('Unknown slot: ')):append(chat.message(args[3])));
            print(chat.header(addon.name):append(chat.color1(6, 'Slots: head, body, hands, legs, feet, main, sub, range')));
            return;
        end

        -- Accept decimal or 0x-prefixed hex.
        local raw = args[4];
        local id = tonumber(raw);
        if (id == nil) then
            print(chat.header(addon.name):append(chat.error('Not a valid model id: ')):append(chat.message(raw)));
            return;
        end
        id = math.floor(id);
        if (id < 0 or id > 0xFFFF) then
            print(chat.header(addon.name):append(chat.error('Model id must be 0-65535.')));
            return;
        end

        overrides[slot] = id;
        apply_look();
        print(chat.header(addon.name):append(chat.message('Set ')):append(chat.success(slot)):append(chat.message(' model to ')):append(chat.success('%d'):fmt(id)));
        return;
    end

    print_help(true);
end);

--[[
* event: packet_in
* desc : Reapply overrides so they survive zoning and real equip changes.
--]]
ashita.events.register('packet_in', 'packet_in_cb', function (e)
    if (e.blocked or next(overrides) == nil) then
        return;
    end

    -- Packet: Char Appearance (self) - fires when your equipment changes.
    if (e.id == 0x0051) then
        local p = ffi.cast('uint8_t*', e.data_modified_raw);
        for name, id in pairs(overrides) do
            local o = slots[name].o51;
            p[o]     = id % 0x100;
            p[o + 1] = math.floor(id / 0x100) % 0x100;
        end
    end

    -- Packet: Zone Enter - reapply on every zone.
    if (e.id == 0x000A) then
        local p = ffi.cast('uint8_t*', e.data_modified_raw);
        for name, id in pairs(overrides) do
            local o = slots[name].o0A;
            p[o]     = id % 0x100;
            p[o + 1] = math.floor(id / 0x100) % 0x100;
        end
    end
end);
