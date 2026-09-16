// Box3D -> JavaScript shim for the Babylon.js Box3DPlugin.
//
// Design goals:
//  * Flat C ABI, no embind. Every entry point takes and returns plain ints/floats so calls from
//    JavaScript are cheap. Structs are returned through a shared scratch buffer (bx_Scratch()).
//  * Integer "slots" instead of box3d's 64-bit ids. JavaScript never sees a b3BodyId.
//  * Babylon shapes are created independently of bodies, box3d shapes live on a body. A
//    "shape desc" (bxShapeDesc) stores the geometry and is instantiated on a body when attached.
//  * Events are copied into flat typed buffers once per step so the plugin can read them with a
//    single HEAPF32 view.

#include "box3d/box3d.h"
#include "box3d/collision.h"
#include "box3d/math_functions.h"

#include <emscripten/emscripten.h>
#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define BX_EXPORT EMSCRIPTEN_KEEPALIVE

// ---------------------------------------------------------------------------------------------
// Shared buffers
// ---------------------------------------------------------------------------------------------

#define BX_SCRATCH_SIZE 64
static float s_scratch[BX_SCRATCH_SIZE];

BX_EXPORT float* bx_Scratch( void )
{
	return s_scratch;
}

BX_EXPORT void* bx_Alloc( int bytes )
{
	return malloc( (size_t)( bytes > 0 ? bytes : 1 ) );
}

BX_EXPORT void bx_Free( void* p )
{
	free( p );
}

BX_EXPORT int bx_GetVersion( void )
{
	b3Version v = b3GetVersion();
	return v.major * 10000 + v.minor * 100 + v.revision;
}

typedef struct bxFloatBuffer
{
	float* data;
	int count;
	int capacity;
} bxFloatBuffer;

static void bxFloatBuffer_Reserve( bxFloatBuffer* buf, int count )
{
	if ( count <= buf->capacity )
	{
		return;
	}
	int capacity = buf->capacity == 0 ? 256 : buf->capacity;
	while ( capacity < count )
	{
		capacity *= 2;
	}
	buf->data = (float*)realloc( buf->data, (size_t)capacity * sizeof( float ) );
	buf->capacity = capacity;
}

// ---------------------------------------------------------------------------------------------
// Slot tables
// ---------------------------------------------------------------------------------------------

#define BX_MAX_WORLDS 8
static b3WorldId s_worlds[BX_MAX_WORLDS];

// Height fields have no local transform in box3d, so an offset height field is placed on a static
// helper body that shares the Babylon body's slot.
typedef struct bxHelper
{
	b3BodyId id;
	b3Transform local;
} bxHelper;

typedef struct bxBody
{
	b3BodyId id;
	int world;
	int alive;
	// begin/end touch events and hit events on this body's shapes (Babylon's COLLISION_STARTED/FINISHED and CONTINUED)
	int contactEvents;
	int hitEvents;
	int shapeDesc;
	b3ShapeId* shapes;
	// the description each shape came from, and the description owning its geometry: the same, except for a mesh in a
	// container, where a transformed copy of the mesh is baked for this body (see bxInstantiate)
	int* shapeDescs;
	int* geomDescs;
	int shapeCount;
	int shapeCapacity;
	bxHelper* helpers;
	int helperCount;
	int helperCapacity;
} bxBody;

static void bxReleaseBodyShapes( bxBody* body, int destroyShapes );

static bxBody* s_bodies;
static int s_bodyCount;
static int s_bodyCapacity;
static int* s_freeBodies;
static int s_freeBodyCount;

typedef enum bxShapeKind
{
	bx_sphereDesc = 0,
	bx_capsuleDesc = 1,
	bx_hullDesc = 2,
	bx_meshDesc = 3,
	bx_heightFieldDesc = 4,
	bx_containerDesc = 5,
} bxShapeKind;

typedef struct bxChild
{
	int desc;
	b3Transform transform;
	b3Vec3 scale;
} bxChild;

typedef struct bxShapeDesc
{
	int kind;
	int alive;
	// Number of live box3d shapes that reference mesh/height-field memory owned by this desc.
	int refCount;
	b3Sphere sphere;
	b3Capsule capsule;
	b3HullData* hull;
	b3MeshData* mesh;
	b3Vec3 meshScale;
	b3HeightFieldData* heightField;
	b3Vec3 offset;
	float friction;
	float restitution;
	float density;
	uint64_t categoryBits;
	uint64_t maskBits;
	int groupIndex;
	float rollingResistance;
	int isSensor;
	bxChild* children;
	int childCount;
	int childCapacity;
} bxShapeDesc;

static bxShapeDesc* s_descs;
static int s_descCount;
static int s_descCapacity;
static int* s_freeDescs;
static int s_freeDescCount;

typedef struct bxJoint
{
	b3JointId id;
	int alive;
	// spherical motor target as a relative angular velocity in joint frame A, converted to world space every step
	b3Vec3 motorVelocity;
} bxJoint;

static bxJoint* s_joints;
static int s_jointCount;
static int s_jointCapacity;
static int* s_freeJoints;
static int s_freeJointCount;

static int bxAllocSlot( void** table, int elementSize, int* count, int* capacity, int** freeList, int* freeCount )
{
	if ( *freeCount > 0 )
	{
		*freeCount -= 1;
		return ( *freeList )[*freeCount];
	}
	if ( *count == 0 )
	{
		// slot 0 is reserved as the null slot
		*count = 1;
	}
	if ( *count >= *capacity )
	{
		int newCapacity = *capacity == 0 ? 64 : *capacity * 2;
		*table = realloc( *table, (size_t)newCapacity * (size_t)elementSize );
		*freeList = (int*)realloc( *freeList, (size_t)newCapacity * sizeof( int ) );
		*capacity = newCapacity;
	}
	int slot = *count;
	*count += 1;
	memset( (char*)*table + (size_t)slot * (size_t)elementSize, 0, (size_t)elementSize );
	return slot;
}

static int bxAllocBody( void )
{
	return bxAllocSlot( (void**)&s_bodies, sizeof( bxBody ), &s_bodyCount, &s_bodyCapacity, &s_freeBodies, &s_freeBodyCount );
}

static int bxAllocDesc( void )
{
	return bxAllocSlot( (void**)&s_descs, sizeof( bxShapeDesc ), &s_descCount, &s_descCapacity, &s_freeDescs, &s_freeDescCount );
}

static int bxAllocJoint( void )
{
	return bxAllocSlot( (void**)&s_joints, sizeof( bxJoint ), &s_jointCount, &s_jointCapacity, &s_freeJoints, &s_freeJointCount );
}

/// Slot lookups that failed on a non zero slot. Every entry point returns quietly when it does not recognize a slot,
/// which is the right thing during teardown but hides the two ways this can go wrong for real: a body used after it
/// was destroyed, and a box3d.js loader paired with a box3d.wasm from a different build, where the exports line up
/// with the wrong functions. The plugin reads this and says so once.
static int s_rejectedSlots;

/// Rejected slot lookups since the module was created. Slot 0 means "none" and is not counted.
BX_EXPORT int bx_GetRejectedSlotCount( void )
{
	return s_rejectedSlots;
}

static bxBody* bxGetBody( int slot )
{
	if ( slot <= 0 || slot >= s_bodyCount || s_bodies[slot].alive == 0 )
	{
		s_rejectedSlots += slot > 0 ? 1 : 0;
		return NULL;
	}
	return s_bodies + slot;
}

static bxShapeDesc* bxGetDesc( int slot )
{
	if ( slot <= 0 || slot >= s_descCount || s_descs[slot].alive == 0 )
	{
		s_rejectedSlots += slot > 0 ? 1 : 0;
		return NULL;
	}
	return s_descs + slot;
}

static b3JointId bxGetJointId( int slot )
{
	if ( slot <= 0 || slot >= s_jointCount || s_joints[slot].alive == 0 )
	{
		return b3_nullJointId;
	}
	b3JointId id = s_joints[slot].id;
	if ( b3Joint_IsValid( id ) == false )
	{
		return b3_nullJointId;
	}
	return id;
}

static b3WorldId bxGetWorld( int slot )
{
	if ( slot <= 0 || slot > BX_MAX_WORLDS )
	{
		s_rejectedSlots += slot > 0 ? 1 : 0;
		return b3_nullWorldId;
	}
	b3WorldId world = s_worlds[slot - 1];
	s_rejectedSlots += B3_IS_NULL( world ) ? 1 : 0;
	return world;
}

static int bxBodySlotFromId( b3BodyId bodyId )
{
	if ( b3Body_IsValid( bodyId ) == false )
	{
		return 0;
	}
	return (int)(intptr_t)b3Body_GetUserData( bodyId );
}

static int bxBodySlotFromShape( b3ShapeId shapeId )
{
	if ( b3Shape_IsValid( shapeId ) == false )
	{
		return 0;
	}
	return bxBodySlotFromId( b3Shape_GetBody( shapeId ) );
}

static int bxDescSlotFromShape( b3ShapeId shapeId )
{
	if ( b3Shape_IsValid( shapeId ) == false )
	{
		return 0;
	}
	return (int)(intptr_t)b3Shape_GetUserData( shapeId );
}

// ---------------------------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------------------------

static b3Vec3 bxVec3( float x, float y, float z )
{
	b3Vec3 v = { x, y, z };
	return v;
}

static b3Quat bxQuat( float x, float y, float z, float w )
{
	b3Quat q = { { x, y, z }, w };
	return b3NormalizeQuat( q );
}

static b3Transform bxTransform( float px, float py, float pz, float qx, float qy, float qz, float qw )
{
	b3Transform xf = { { px, py, pz }, { { qx, qy, qz }, qw } };
	xf.q = b3NormalizeQuat( xf.q );
	return xf;
}

static void bxWriteVec3( int offset, b3Vec3 v )
{
	s_scratch[offset + 0] = v.x;
	s_scratch[offset + 1] = v.y;
	s_scratch[offset + 2] = v.z;
}

static void bxWriteQuat( int offset, b3Quat q )
{
	s_scratch[offset + 0] = q.v.x;
	s_scratch[offset + 1] = q.v.y;
	s_scratch[offset + 2] = q.v.z;
	s_scratch[offset + 3] = q.s;
}

static b3Vec3 bxMulScale( b3Vec3 a, b3Vec3 b )
{
	return bxVec3( a.x * b.x, a.y * b.y, a.z * b.z );
}

static float bxMaxAbsScale( b3Vec3 s )
{
	float m = fabsf( s.x );
	if ( fabsf( s.y ) > m )
	{
		m = fabsf( s.y );
	}
	if ( fabsf( s.z ) > m )
	{
		m = fabsf( s.z );
	}
	return m;
}

static int bxIsIdentity( b3Transform xf, b3Vec3 scale )
{
	return xf.p.x == 0.0f && xf.p.y == 0.0f && xf.p.z == 0.0f && xf.q.v.x == 0.0f && xf.q.v.y == 0.0f && xf.q.v.z == 0.0f &&
		   xf.q.s == 1.0f && scale.x == 1.0f && scale.y == 1.0f && scale.z == 1.0f;
}

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------

BX_EXPORT int bx_CreateWorld( float gx, float gy, float gz )
{
	for ( int i = 0; i < BX_MAX_WORLDS; ++i )
	{
		if ( B3_IS_NULL( s_worlds[i] ) )
		{
			b3WorldDef def = b3DefaultWorldDef();
			def.gravity = bxVec3( gx, gy, gz );
			def.workerCount = 1;
			s_worlds[i] = b3CreateWorld( &def );
			return i + 1;
		}
	}
	return 0;
}

BX_EXPORT void bx_DestroyWorld( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NULL( worldId ) )
	{
		return;
	}
	b3DestroyWorld( worldId );
	s_worlds[w - 1] = b3_nullWorldId;
	for ( int i = 1; i < s_bodyCount; ++i )
	{
		if ( s_bodies[i].alive && s_bodies[i].world == w )
		{
			// the world is gone, so the shapes are too, but their geometry still has to be released: mesh and height
			// field descriptions are reference counted and a mesh baked for this body is owned by it
			bxReleaseBodyShapes( s_bodies + i, 0 );
			free( s_bodies[i].shapes );
			free( s_bodies[i].shapeDescs );
			free( s_bodies[i].geomDescs );
			free( s_bodies[i].helpers );
			memset( s_bodies + i, 0, sizeof( bxBody ) );
			s_freeBodies[s_freeBodyCount++] = i;
		}
	}
}

BX_EXPORT void bx_World_Step( int w, float dt, int subSteps )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NULL( worldId ) )
	{
		return;
	}
	b3World_Step( worldId, dt, subSteps );
}

BX_EXPORT void bx_World_SetGravity( int w, float gx, float gy, float gz )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NULL( worldId ) )
	{
		return;
	}
	b3World_SetGravity( worldId, bxVec3( gx, gy, gz ) );
}

BX_EXPORT void bx_World_SetMaximumLinearSpeed( int w, float speed )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NON_NULL( worldId ) )
	{
		b3World_SetMaximumLinearSpeed( worldId, speed );
	}
}

BX_EXPORT float bx_World_GetMaximumLinearSpeed( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	return B3_IS_NON_NULL( worldId ) ? b3World_GetMaximumLinearSpeed( worldId ) : 0.0f;
}

BX_EXPORT void bx_World_EnableSleeping( int w, int flag )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NON_NULL( worldId ) )
	{
		b3World_EnableSleeping( worldId, flag != 0 );
	}
}

BX_EXPORT void bx_World_EnableContinuous( int w, int flag )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NON_NULL( worldId ) )
	{
		b3World_EnableContinuous( worldId, flag != 0 );
	}
}

BX_EXPORT void bx_World_SetContactTuning( int w, float hertz, float dampingRatio, float contactSpeed )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NON_NULL( worldId ) )
	{
		b3World_SetContactTuning( worldId, hertz, dampingRatio, contactSpeed );
	}
}

BX_EXPORT void bx_World_Explode( int w, float px, float py, float pz, float radius, float falloff, float impulsePerArea )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NULL( worldId ) )
	{
		return;
	}
	b3ExplosionDef def = b3DefaultExplosionDef();
	def.position = bxVec3( px, py, pz );
	def.radius = radius;
	def.falloff = falloff;
	def.impulsePerArea = impulsePerArea;
	b3World_Explode( worldId, &def );
}

BX_EXPORT int bx_World_GetAwakeBodyCount( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	return B3_IS_NON_NULL( worldId ) ? b3World_GetAwakeBodyCount( worldId ) : 0;
}

/// Number of joint force/torque threshold events from the last step. The plugin does not consume them; with the
/// default thresholds (FLT_MAX) this stays 0.
BX_EXPORT int bx_World_GetJointEventCount( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	return B3_IS_NON_NULL( worldId ) ? b3World_GetJointEvents( worldId ).count : 0;
}

/// scratch: [bodyCount, shapeCount, contactCount, jointCount, islandCount, stepMs, collideMs, solveMs]
BX_EXPORT void bx_World_GetStats( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	memset( s_scratch, 0, 8 * sizeof( float ) );
	if ( B3_IS_NULL( worldId ) )
	{
		return;
	}
	b3Counters counters = b3World_GetCounters( worldId );
	b3Profile profile = b3World_GetProfile( worldId );
	s_scratch[0] = (float)counters.bodyCount;
	s_scratch[1] = (float)counters.shapeCount;
	s_scratch[2] = (float)counters.contactCount;
	s_scratch[3] = (float)counters.jointCount;
	s_scratch[4] = (float)counters.islandCount;
	s_scratch[5] = profile.step;
	s_scratch[6] = profile.collide;
	s_scratch[7] = profile.solve;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

static bxFloatBuffer s_moveEvents;
static bxFloatBuffer s_contactEvents;
static bxFloatBuffer s_sensorEvents;

#define BX_MOVE_EVENT_STRIDE 9
#define BX_CONTACT_EVENT_STRIDE 12
#define BX_SENSOR_EVENT_STRIDE 5

BX_EXPORT float* bx_MoveEventsPtr( void )
{
	return s_moveEvents.data;
}

BX_EXPORT float* bx_ContactEventsPtr( void )
{
	return s_contactEvents.data;
}

BX_EXPORT float* bx_SensorEventsPtr( void )
{
	return s_sensorEvents.data;
}

/// Each record: [bodySlot, px, py, pz, qx, qy, qz, qw, fellAsleep]
BX_EXPORT int bx_World_GetMoveEvents( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	s_moveEvents.count = 0;
	if ( B3_IS_NULL( worldId ) )
	{
		return 0;
	}
	b3BodyEvents events = b3World_GetBodyEvents( worldId );
	bxFloatBuffer_Reserve( &s_moveEvents, events.moveCount * BX_MOVE_EVENT_STRIDE );
	float* out = s_moveEvents.data;
	int count = 0;
	for ( int i = 0; i < events.moveCount; ++i )
	{
		const b3BodyMoveEvent* e = events.moveEvents + i;
		int slot = (int)(intptr_t)e->userData;
		if ( slot <= 0 )
		{
			continue;
		}
		out[0] = (float)slot;
		out[1] = e->transform.p.x;
		out[2] = e->transform.p.y;
		out[3] = e->transform.p.z;
		out[4] = e->transform.q.v.x;
		out[5] = e->transform.q.v.y;
		out[6] = e->transform.q.v.z;
		out[7] = e->transform.q.s;
		out[8] = e->fellAsleep ? 1.0f : 0.0f;
		out += BX_MOVE_EVENT_STRIDE;
		count += 1;
	}
	s_moveEvents.count = count;
	return count;
}

/// Writes the contact point, normal (from shape A to shape B) and the total normal impulse of a begin touch event,
/// taken from the contact's first manifold. Havok reports these on collision started events too.
static void bxWriteBeginTouchData( float* out, b3ContactId contactId, b3ShapeId shapeIdA )
{
	memset( out, 0, 7 * sizeof( float ) );
	if ( b3Contact_IsValid( contactId ) == false )
	{
		return;
	}
	b3ContactData data = b3Contact_GetData( contactId );
	if ( data.manifoldCount <= 0 || data.manifolds[0].pointCount <= 0 )
	{
		return;
	}
	const b3Manifold* manifold = data.manifolds + 0;
	// manifold anchors are relative to the center of mass of the contact's body A, which may be the event's shape B
	int flipped = B3_ID_EQUALS( data.shapeIdA, shapeIdA ) == false;
	b3Pos center = b3Body_GetWorldCenter( b3Shape_GetBody( data.shapeIdA ) );
	b3Vec3 anchor = b3Vec3_zero;
	float impulse = 0.0f;
	for ( int i = 0; i < manifold->pointCount; ++i )
	{
		anchor = b3Add( anchor, manifold->points[i].anchorA );
		impulse += manifold->points[i].totalNormalImpulse;
	}
	anchor = b3MulSV( 1.0f / (float)manifold->pointCount, anchor );
	b3Pos point = b3OffsetPos( center, anchor );
	b3Vec3 normal = flipped ? b3Neg( manifold->normal ) : manifold->normal;
	out[0] = point.x;
	out[1] = point.y;
	out[2] = point.z;
	out[3] = normal.x;
	out[4] = normal.y;
	out[5] = normal.z;
	out[6] = impulse;
}

/// Each record: [kind (0 begin, 1 end, 2 hit), shapeDescA, shapeDescB, bodyA, bodyB, px, py, pz, nx, ny, nz, value]
/// Begin events carry the contact point, normal and the total normal impulse of the step, hit events the point, normal
/// and approach speed, end events nothing.
BX_EXPORT int bx_World_GetContactEvents( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	s_contactEvents.count = 0;
	if ( B3_IS_NULL( worldId ) )
	{
		return 0;
	}
	b3ContactEvents events = b3World_GetContactEvents( worldId );
	int total = events.beginCount + events.endCount + events.hitCount;
	bxFloatBuffer_Reserve( &s_contactEvents, total * BX_CONTACT_EVENT_STRIDE );
	float* out = s_contactEvents.data;
	int count = 0;

	for ( int i = 0; i < events.beginCount; ++i )
	{
		const b3ContactBeginTouchEvent* e = events.beginEvents + i;
		int bodyA = bxBodySlotFromShape( e->shapeIdA );
		int bodyB = bxBodySlotFromShape( e->shapeIdB );
		if ( bodyA == 0 || bodyB == 0 )
		{
			continue;
		}
		out[0] = 0.0f;
		out[1] = (float)bxDescSlotFromShape( e->shapeIdA );
		out[2] = (float)bxDescSlotFromShape( e->shapeIdB );
		out[3] = (float)bodyA;
		out[4] = (float)bodyB;
		bxWriteBeginTouchData( out + 5, e->contactId, e->shapeIdA );
		out += BX_CONTACT_EVENT_STRIDE;
		count += 1;
	}

	for ( int i = 0; i < events.hitCount; ++i )
	{
		const b3ContactHitEvent* e = events.hitEvents + i;
		int bodyA = bxBodySlotFromShape( e->shapeIdA );
		int bodyB = bxBodySlotFromShape( e->shapeIdB );
		if ( bodyA == 0 || bodyB == 0 )
		{
			continue;
		}
		out[0] = 2.0f;
		out[1] = (float)bxDescSlotFromShape( e->shapeIdA );
		out[2] = (float)bxDescSlotFromShape( e->shapeIdB );
		out[3] = (float)bodyA;
		out[4] = (float)bodyB;
		out[5] = e->point.x;
		out[6] = e->point.y;
		out[7] = e->point.z;
		out[8] = e->normal.x;
		out[9] = e->normal.y;
		out[10] = e->normal.z;
		out[11] = e->approachSpeed;
		out += BX_CONTACT_EVENT_STRIDE;
		count += 1;
	}

	for ( int i = 0; i < events.endCount; ++i )
	{
		const b3ContactEndTouchEvent* e = events.endEvents + i;
		int bodyA = bxBodySlotFromShape( e->shapeIdA );
		int bodyB = bxBodySlotFromShape( e->shapeIdB );
		if ( bodyA == 0 || bodyB == 0 )
		{
			continue;
		}
		out[0] = 1.0f;
		out[1] = (float)bxDescSlotFromShape( e->shapeIdA );
		out[2] = (float)bxDescSlotFromShape( e->shapeIdB );
		out[3] = (float)bodyA;
		out[4] = (float)bodyB;
		memset( out + 5, 0, 7 * sizeof( float ) );
		out += BX_CONTACT_EVENT_STRIDE;
		count += 1;
	}

	s_contactEvents.count = count;
	return count;
}

/// Each record: [kind (0 begin, 1 end), sensorShapeDesc, visitorShapeDesc, sensorBody, visitorBody]
BX_EXPORT int bx_World_GetSensorEvents( int w )
{
	b3WorldId worldId = bxGetWorld( w );
	s_sensorEvents.count = 0;
	if ( B3_IS_NULL( worldId ) )
	{
		return 0;
	}
	b3SensorEvents events = b3World_GetSensorEvents( worldId );
	bxFloatBuffer_Reserve( &s_sensorEvents, ( events.beginCount + events.endCount ) * BX_SENSOR_EVENT_STRIDE );
	float* out = s_sensorEvents.data;
	int count = 0;
	for ( int i = 0; i < events.beginCount; ++i )
	{
		const b3SensorBeginTouchEvent* e = events.beginEvents + i;
		int bodyA = bxBodySlotFromShape( e->sensorShapeId );
		int bodyB = bxBodySlotFromShape( e->visitorShapeId );
		if ( bodyA == 0 || bodyB == 0 )
		{
			continue;
		}
		out[0] = 0.0f;
		out[1] = (float)bxDescSlotFromShape( e->sensorShapeId );
		out[2] = (float)bxDescSlotFromShape( e->visitorShapeId );
		out[3] = (float)bodyA;
		out[4] = (float)bodyB;
		out += BX_SENSOR_EVENT_STRIDE;
		count += 1;
	}
	for ( int i = 0; i < events.endCount; ++i )
	{
		const b3SensorEndTouchEvent* e = events.endEvents + i;
		int bodyA = bxBodySlotFromShape( e->sensorShapeId );
		int bodyB = bxBodySlotFromShape( e->visitorShapeId );
		if ( bodyA == 0 || bodyB == 0 )
		{
			continue;
		}
		out[0] = 1.0f;
		out[1] = (float)bxDescSlotFromShape( e->sensorShapeId );
		out[2] = (float)bxDescSlotFromShape( e->visitorShapeId );
		out[3] = (float)bodyA;
		out[4] = (float)bodyB;
		out += BX_SENSOR_EVENT_STRIDE;
		count += 1;
	}
	s_sensorEvents.count = count;
	return count;
}

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

/// type: 0 static, 1 kinematic, 2 dynamic
BX_EXPORT int bx_CreateBody( int w, int type, float px, float py, float pz, float qx, float qy, float qz, float qw, int isAwake )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NULL( worldId ) )
	{
		return 0;
	}
	int slot = bxAllocBody();
	bxBody* body = s_bodies + slot;
	b3BodyDef def = b3DefaultBodyDef();
	def.type = (b3BodyType)type;
	def.position = bxVec3( px, py, pz );
	def.rotation = bxQuat( qx, qy, qz, qw );
	def.isAwake = isAwake != 0;
	def.userData = (void*)(intptr_t)slot;
	body->id = b3CreateBody( worldId, &def );
	body->world = w;
	body->alive = 1;
	return slot;
}

static void bxDestroyHelpers( bxBody* body )
{
	for ( int i = 0; i < body->helperCount; ++i )
	{
		if ( b3Body_IsValid( body->helpers[i].id ) )
		{
			b3DestroyBody( body->helpers[i].id );
		}
	}
	body->helperCount = 0;
}

static void bxDescRelease( int slot );
BX_EXPORT void bx_ShapeDesc_Destroy( int slot );

static void bxReleaseBodyShapes( bxBody* body, int destroyShapes )
{
	if ( destroyShapes )
	{
		bxDestroyHelpers( body );
	}
	for ( int i = 0; i < body->shapeCount; ++i )
	{
		if ( destroyShapes && b3Shape_IsValid( body->shapes[i] ) )
		{
			b3DestroyShape( body->shapes[i], false );
		}
		int geomSlot = body->geomDescs[i];
		if ( geomSlot != body->shapeDescs[i] )
		{
			// a mesh baked for this body alone, nothing else refers to it
			bx_ShapeDesc_Destroy( geomSlot );
		}
		bxDescRelease( geomSlot );
	}
	body->shapeCount = 0;
}

BX_EXPORT void bx_DestroyBody( int slot )
{
	bxBody* body = bxGetBody( slot );
	if ( body == NULL )
	{
		return;
	}
	// b3DestroyBody destroys attached shapes and joints; free the geometry only once no shape can refer to it
	bxDestroyHelpers( body );
	if ( b3Body_IsValid( body->id ) )
	{
		b3DestroyBody( body->id );
	}
	bxReleaseBodyShapes( body, 0 );
	free( body->shapes );
	free( body->shapeDescs );
	free( body->geomDescs );
	free( body->helpers );
	memset( body, 0, sizeof( bxBody ) );
	s_freeBodies[s_freeBodyCount++] = slot;
}

#define BX_BODY( slot )                                                                                                          \
	bxBody* body = bxGetBody( slot );                                                                                            \
	if ( body == NULL || b3Body_IsValid( body->id ) == false )                                                                   \
	{                                                                                                                            \
		return;                                                                                                                  \
	}

#define BX_BODY_RET( slot, value )                                                                                               \
	bxBody* body = bxGetBody( slot );                                                                                            \
	if ( body == NULL || b3Body_IsValid( body->id ) == false )                                                                   \
	{                                                                                                                            \
		return value;                                                                                                            \
	}

BX_EXPORT void bx_Body_SetType( int slot, int type )
{
	BX_BODY( slot );
	b3Body_SetType( body->id, (b3BodyType)type );
}

BX_EXPORT int bx_Body_GetType( int slot )
{
	BX_BODY_RET( slot, 0 );
	return (int)b3Body_GetType( body->id );
}

BX_EXPORT void bx_Body_SetTransform( int slot, float px, float py, float pz, float qx, float qy, float qz, float qw )
{
	BX_BODY( slot );
	b3Body_SetTransform( body->id, bxVec3( px, py, pz ), bxQuat( qx, qy, qz, qw ) );
	if ( body->helperCount > 0 )
	{
		b3Transform xf = bxTransform( px, py, pz, qx, qy, qz, qw );
		for ( int i = 0; i < body->helperCount; ++i )
		{
			if ( b3Body_IsValid( body->helpers[i].id ) )
			{
				b3Transform h = b3MulTransforms( xf, body->helpers[i].local );
				b3Body_SetTransform( body->helpers[i].id, h.p, h.q );
			}
		}
	}
}

/// scratch: [px, py, pz, qx, qy, qz, qw]
BX_EXPORT void bx_Body_GetTransform( int slot )
{
	BX_BODY( slot );
	b3WorldTransform xf = b3Body_GetTransform( body->id );
	bxWriteVec3( 0, xf.p );
	bxWriteQuat( 3, xf.q );
}

BX_EXPORT void bx_Body_SetTargetTransform( int slot, float px, float py, float pz, float qx, float qy, float qz, float qw, float dt )
{
	BX_BODY( slot );
	b3WorldTransform xf = bxTransform( px, py, pz, qx, qy, qz, qw );
	b3Body_SetTargetTransform( body->id, xf, dt, true );
}

BX_EXPORT void bx_Body_SetLinearVelocity( int slot, float x, float y, float z )
{
	BX_BODY( slot );
	b3Body_SetLinearVelocity( body->id, bxVec3( x, y, z ) );
}

BX_EXPORT void bx_Body_GetLinearVelocity( int slot )
{
	BX_BODY( slot );
	bxWriteVec3( 0, b3Body_GetLinearVelocity( body->id ) );
}

BX_EXPORT void bx_Body_SetAngularVelocity( int slot, float x, float y, float z )
{
	BX_BODY( slot );
	b3Body_SetAngularVelocity( body->id, bxVec3( x, y, z ) );
}

BX_EXPORT void bx_Body_GetAngularVelocity( int slot )
{
	BX_BODY( slot );
	bxWriteVec3( 0, b3Body_GetAngularVelocity( body->id ) );
}

BX_EXPORT void bx_Body_SetLinearDamping( int slot, float damping )
{
	BX_BODY( slot );
	b3Body_SetLinearDamping( body->id, damping );
}

BX_EXPORT float bx_Body_GetLinearDamping( int slot )
{
	BX_BODY_RET( slot, 0.0f );
	return b3Body_GetLinearDamping( body->id );
}

BX_EXPORT void bx_Body_SetAngularDamping( int slot, float damping )
{
	BX_BODY( slot );
	b3Body_SetAngularDamping( body->id, damping );
}

BX_EXPORT float bx_Body_GetAngularDamping( int slot )
{
	BX_BODY_RET( slot, 0.0f );
	return b3Body_GetAngularDamping( body->id );
}

BX_EXPORT void bx_Body_SetGravityScale( int slot, float scale )
{
	BX_BODY( slot );
	b3Body_SetGravityScale( body->id, scale );
}

BX_EXPORT float bx_Body_GetGravityScale( int slot )
{
	BX_BODY_RET( slot, 1.0f );
	return b3Body_GetGravityScale( body->id );
}

BX_EXPORT void bx_Body_ApplyForce( int slot, float fx, float fy, float fz, float px, float py, float pz )
{
	BX_BODY( slot );
	b3Body_ApplyForce( body->id, bxVec3( fx, fy, fz ), bxVec3( px, py, pz ), true );
}

BX_EXPORT void bx_Body_ApplyForceToCenter( int slot, float fx, float fy, float fz )
{
	BX_BODY( slot );
	b3Body_ApplyForceToCenter( body->id, bxVec3( fx, fy, fz ), true );
}

BX_EXPORT void bx_Body_ApplyTorque( int slot, float x, float y, float z )
{
	BX_BODY( slot );
	b3Body_ApplyTorque( body->id, bxVec3( x, y, z ), true );
}

BX_EXPORT void bx_Body_ApplyLinearImpulse( int slot, float ix, float iy, float iz, float px, float py, float pz )
{
	BX_BODY( slot );
	b3Body_ApplyLinearImpulse( body->id, bxVec3( ix, iy, iz ), bxVec3( px, py, pz ), true );
}

BX_EXPORT void bx_Body_ApplyLinearImpulseToCenter( int slot, float ix, float iy, float iz )
{
	BX_BODY( slot );
	b3Body_ApplyLinearImpulseToCenter( body->id, bxVec3( ix, iy, iz ), true );
}

BX_EXPORT void bx_Body_ApplyAngularImpulse( int slot, float x, float y, float z )
{
	BX_BODY( slot );
	b3Body_ApplyAngularImpulse( body->id, bxVec3( x, y, z ), true );
}

BX_EXPORT void bx_Body_SetAwake( int slot, int awake )
{
	BX_BODY( slot );
	b3Body_SetAwake( body->id, awake != 0 );
}

BX_EXPORT int bx_Body_IsAwake( int slot )
{
	BX_BODY_RET( slot, 0 );
	return b3Body_IsAwake( body->id ) ? 1 : 0;
}

BX_EXPORT void bx_Body_EnableSleep( int slot, int flag )
{
	BX_BODY( slot );
	b3Body_EnableSleep( body->id, flag != 0 );
}

BX_EXPORT void bx_Body_SetBullet( int slot, int flag )
{
	BX_BODY( slot );
	b3Body_SetBullet( body->id, flag != 0 );
}

BX_EXPORT void bx_Body_AllowFastRotation( int slot, int flag )
{
	BX_BODY( slot );
	b3Body_AllowFastRotation( body->id, flag != 0 );
}

BX_EXPORT void bx_Body_SetMotionLocks( int slot, int lx, int ly, int lz, int ax, int ay, int az )
{
	BX_BODY( slot );
	b3MotionLocks locks = { lx != 0, ly != 0, lz != 0, ax != 0, ay != 0, az != 0 };
	b3Body_SetMotionLocks( body->id, locks );
}

/// scratch: [minx, miny, minz, maxx, maxy, maxz]
BX_EXPORT void bx_Body_GetAABB( int slot )
{
	BX_BODY( slot );
	b3AABB aabb = b3Body_ComputeAABB( body->id );
	bxWriteVec3( 0, aabb.lowerBound );
	bxWriteVec3( 3, aabb.upperBound );
}

/// Mass data the body's shapes would give it, whatever its type. Box3D keeps mass 0 on static and kinematic bodies,
/// while Havok reports the shape mass for every body, so the plugin uses this for its mass property getters.
/// scratch: [mass, cx, cy, cz, ixx, iyy, izz, ixy, ixz, iyz]
BX_EXPORT void bx_Body_ComputeShapeMassData( int slot )
{
	memset( s_scratch, 0, 10 * sizeof( float ) );
	bxBody* body = bxGetBody( slot );
	if ( body == NULL || b3Body_IsValid( body->id ) == false )
	{
		return;
	}
	float mass = 0.0f;
	b3Vec3 center = b3Vec3_zero;
	for ( int i = 0; i < body->shapeCount; ++i )
	{
		if ( b3Shape_IsValid( body->shapes[i] ) == false )
		{
			continue;
		}
		b3MassData md = b3Shape_ComputeMassData( body->shapes[i] );
		mass += md.mass;
		center = b3MulAdd( center, md.mass, md.center );
	}
	if ( mass <= 0.0f )
	{
		return;
	}
	center = b3MulSV( 1.0f / mass, center );
	// parallel axis theorem: shift each shape's inertia to the combined center of mass
	b3Matrix3 inertia = b3Mat3_zero;
	for ( int i = 0; i < body->shapeCount; ++i )
	{
		if ( b3Shape_IsValid( body->shapes[i] ) == false )
		{
			continue;
		}
		b3MassData md = b3Shape_ComputeMassData( body->shapes[i] );
		b3Vec3 d = b3Sub( md.center, center );
		float dd = b3Dot( d, d );
		inertia = b3AddMM( inertia, md.inertia );
		inertia.cx.x += md.mass * ( dd - d.x * d.x );
		inertia.cy.y += md.mass * ( dd - d.y * d.y );
		inertia.cz.z += md.mass * ( dd - d.z * d.z );
		inertia.cy.x -= md.mass * d.x * d.y;
		inertia.cx.y -= md.mass * d.x * d.y;
		inertia.cz.x -= md.mass * d.x * d.z;
		inertia.cx.z -= md.mass * d.x * d.z;
		inertia.cz.y -= md.mass * d.y * d.z;
		inertia.cy.z -= md.mass * d.y * d.z;
	}
	s_scratch[0] = mass;
	bxWriteVec3( 1, center );
	s_scratch[4] = inertia.cx.x;
	s_scratch[5] = inertia.cy.y;
	s_scratch[6] = inertia.cz.z;
	s_scratch[7] = inertia.cy.x;
	s_scratch[8] = inertia.cz.x;
	s_scratch[9] = inertia.cz.y;
}

/// scratch: [mass, cx, cy, cz, ixx, iyy, izz, ixy, ixz, iyz], the inertia tensor about the center of mass
BX_EXPORT void bx_Body_GetMassData( int slot )
{
	BX_BODY( slot );
	b3MassData md = b3Body_GetMassData( body->id );
	s_scratch[0] = md.mass;
	bxWriteVec3( 1, md.center );
	s_scratch[4] = md.inertia.cx.x;
	s_scratch[5] = md.inertia.cy.y;
	s_scratch[6] = md.inertia.cz.z;
	s_scratch[7] = md.inertia.cy.x;
	s_scratch[8] = md.inertia.cz.x;
	s_scratch[9] = md.inertia.cz.y;
}

/// Full symmetric inertia tensor, needed for Babylon mass properties with an inertia orientation.
BX_EXPORT void bx_Body_SetMassDataFull( int slot, float mass, float cx, float cy, float cz, float ixx, float iyy, float izz,
										float ixy, float ixz, float iyz )
{
	BX_BODY( slot );
	b3MassData md;
	md.mass = mass;
	md.center = bxVec3( cx, cy, cz );
	md.inertia.cx = bxVec3( ixx, ixy, ixz );
	md.inertia.cy = bxVec3( ixy, iyy, iyz );
	md.inertia.cz = bxVec3( ixz, iyz, izz );
	b3Body_SetMassData( body->id, md );
}

BX_EXPORT void bx_Body_SetMassData( int slot, float mass, float cx, float cy, float cz, float ixx, float iyy, float izz )
{
	bx_Body_SetMassDataFull( slot, mass, cx, cy, cz, ixx, iyy, izz, 0.0f, 0.0f, 0.0f );
}

/// scratch: [lx, ly, lz, ax, ay, az], 1 where the motion is locked
BX_EXPORT void bx_Body_GetMotionLocks( int slot )
{
	BX_BODY( slot );
	b3MotionLocks locks = b3Body_GetMotionLocks( body->id );
	s_scratch[0] = locks.linearX ? 1.0f : 0.0f;
	s_scratch[1] = locks.linearY ? 1.0f : 0.0f;
	s_scratch[2] = locks.linearZ ? 1.0f : 0.0f;
	s_scratch[3] = locks.angularX ? 1.0f : 0.0f;
	s_scratch[4] = locks.angularY ? 1.0f : 0.0f;
	s_scratch[5] = locks.angularZ ? 1.0f : 0.0f;
}

BX_EXPORT void bx_Body_ApplyMassFromShapes( int slot )
{
	BX_BODY( slot );
	b3Body_ApplyMassFromShapes( body->id );
}

BX_EXPORT int bx_Body_GetShapeCount( int slot )
{
	BX_BODY_RET( slot, 0 );
	return body->shapeCount;
}

/// Begin/end touch events and hit events are enabled separately so a body only pays for the events it asked for.
BX_EXPORT void bx_Body_SetEventFlags( int slot, int contactEvents, int hitEvents )
{
	BX_BODY( slot );
	body->contactEvents = contactEvents != 0;
	body->hitEvents = hitEvents != 0;
	for ( int i = 0; i < body->shapeCount; ++i )
	{
		if ( b3Shape_IsValid( body->shapes[i] ) )
		{
			b3Shape_EnableContactEvents( body->shapes[i], body->contactEvents != 0 );
			b3Shape_EnableHitEvents( body->shapes[i], body->hitEvents != 0 );
		}
	}
}

/// Bit 1: begin/end touch events, bit 2: hit events.
BX_EXPORT int bx_Body_GetEventFlags( int slot )
{
	BX_BODY_RET( slot, 0 );
	return ( body->contactEvents ? 1 : 0 ) | ( body->hitEvents ? 2 : 0 );
}

BX_EXPORT void bx_Body_EnableContactEvents( int slot, int flag )
{
	bx_Body_SetEventFlags( slot, flag, flag );
}

// ---------------------------------------------------------------------------------------------
// Shape descriptions
// ---------------------------------------------------------------------------------------------

static int bxNewDesc( int kind )
{
	int slot = bxAllocDesc();
	bxShapeDesc* desc = s_descs + slot;
	desc->kind = kind;
	desc->alive = 1;
	desc->friction = 0.5f;
	desc->restitution = 0.0f;
	desc->density = 1000.0f;
	desc->categoryBits = B3_DEFAULT_CATEGORY_BITS;
	desc->maskBits = B3_DEFAULT_MASK_BITS;
	desc->meshScale = b3Vec3_one;
	return slot;
}

BX_EXPORT int bx_ShapeDesc_CreateSphere( float cx, float cy, float cz, float radius )
{
	int slot = bxNewDesc( bx_sphereDesc );
	s_descs[slot].sphere.center = bxVec3( cx, cy, cz );
	s_descs[slot].sphere.radius = radius;
	return slot;
}

BX_EXPORT int bx_ShapeDesc_CreateCapsule( float ax, float ay, float az, float bx, float by, float bz, float radius )
{
	int slot = bxNewDesc( bx_capsuleDesc );
	s_descs[slot].capsule.center1 = bxVec3( ax, ay, az );
	s_descs[slot].capsule.center2 = bxVec3( bx, by, bz );
	s_descs[slot].capsule.radius = radius;
	return slot;
}

/// Box with half extents, local center and rotation baked into the hull.
BX_EXPORT int bx_ShapeDesc_CreateBox( float hx, float hy, float hz, float px, float py, float pz, float qx, float qy, float qz,
									  float qw )
{
	b3BoxHull box = b3MakeTransformedBoxHull( hx, hy, hz, bxTransform( px, py, pz, qx, qy, qz, qw ) );
	b3HullData* hull = b3CloneHull( &box.base );
	if ( hull == NULL )
	{
		return 0;
	}
	int slot = bxNewDesc( bx_hullDesc );
	s_descs[slot].hull = hull;
	return slot;
}

/// Tessellated cylinder along the local y axis, then transformed.
BX_EXPORT int bx_ShapeDesc_CreateCylinder( float height, float radius, int sides, float px, float py, float pz, float qx, float qy,
										   float qz, float qw )
{
	b3HullData* base = b3CreateCylinder( height, radius, 0.0f, sides );
	if ( base == NULL )
	{
		return 0;
	}
	b3HullData* hull = b3CloneAndTransformHull( base, bxTransform( px, py, pz, qx, qy, qz, qw ), b3Vec3_one );
	b3DestroyHull( base );
	if ( hull == NULL )
	{
		return 0;
	}
	int slot = bxNewDesc( bx_hullDesc );
	s_descs[slot].hull = hull;
	return slot;
}

/// points: pointCount * 3 floats
BX_EXPORT int bx_ShapeDesc_CreateHull( const float* points, int pointCount )
{
	// Box3D hulls are limited to 128 vertices, faces and edges. Dense meshes (a torus knot, a sphere) blow the
	// edge budget long before the vertex budget, so simplify progressively until the builder accepts it.
	static const int s_vertexBudgets[] = { 40, 28, 20, 14, 10, 8 };
	b3HullData* hull = NULL;
	for ( int i = 0; i < (int)( sizeof( s_vertexBudgets ) / sizeof( s_vertexBudgets[0] ) ) && hull == NULL; ++i )
	{
		hull = b3CreateHull( (const b3Vec3*)points, pointCount, s_vertexBudgets[i] );
	}
	if ( hull == NULL )
	{
		return 0;
	}
	int slot = bxNewDesc( bx_hullDesc );
	s_descs[slot].hull = hull;
	return slot;
}

/// vertices: vertexCount * 3 floats, indices: triangleCount * 3 ints
BX_EXPORT int bx_ShapeDesc_CreateMesh( const float* vertices, int vertexCount, const int* indices, int triangleCount, float sx,
									   float sy, float sz, int clockwise, int weld )
{
	b3MeshDef def = { 0 };
	def.vertices = (b3Vec3*)vertices;
	def.vertexCount = vertexCount;
	def.indices = (int32_t*)indices;
	def.triangleCount = triangleCount;
	def.identifyEdges = true;
	def.clockWiseWinding = clockwise != 0;
	def.weldVertices = weld != 0;
	def.weldTolerance = 0.001f;
	b3MeshData* mesh = b3CreateMesh( &def, NULL, 0 );
	if ( mesh == NULL )
	{
		return 0;
	}
	int slot = bxNewDesc( bx_meshDesc );
	s_descs[slot].mesh = mesh;
	s_descs[slot].meshScale = bxVec3( sx, sy, sz );
	return slot;
}

/// heights: countX * countZ floats indexed [z * countX + x]
/// materials: (countX - 1) * (countZ - 1) cell material indices indexed [z * (countX - 1) + x], or NULL for every cell 0.
/// A cell of B3_HEIGHT_FIELD_HOLE (255) is a hole: nothing collides with it and rays pass through. Box3D copies them.
BX_EXPORT int bx_ShapeDesc_CreateHeightField( const float* heights, const unsigned char* materials, int countX, int countZ,
											  float sx, float sy, float sz, int clockwise, float ox, float oy, float oz )
{
	float minHeight = heights[0];
	float maxHeight = heights[0];
	for ( int i = 1; i < countX * countZ; ++i )
	{
		if ( heights[i] < minHeight )
		{
			minHeight = heights[i];
		}
		if ( heights[i] > maxHeight )
		{
			maxHeight = heights[i];
		}
	}
	if ( maxHeight - minHeight < 0.001f )
	{
		maxHeight = minHeight + 0.001f;
	}
	b3HeightFieldDef def = { 0 };
	def.heights = (float*)heights;
	def.materialIndices = (uint8_t*)materials;
	def.countX = countX;
	def.countZ = countZ;
	def.scale = bxVec3( sx, sy, sz );
	def.globalMinimumHeight = minHeight;
	def.globalMaximumHeight = maxHeight;
	def.clockwiseWinding = clockwise != 0;
	b3HeightFieldData* hf = b3CreateHeightField( &def );
	if ( hf == NULL )
	{
		return 0;
	}
	int slot = bxNewDesc( bx_heightFieldDesc );
	s_descs[slot].heightField = hf;
	s_descs[slot].offset = bxVec3( ox, oy, oz );
	return slot;
}

BX_EXPORT int bx_ShapeDesc_CreateContainer( void )
{
	return bxNewDesc( bx_containerDesc );
}

BX_EXPORT void bx_ShapeDesc_AddChild( int parentSlot, int childSlot, float px, float py, float pz, float qx, float qy, float qz,
									  float qw, float sx, float sy, float sz )
{
	bxShapeDesc* parent = bxGetDesc( parentSlot );
	bxShapeDesc* child = bxGetDesc( childSlot );
	if ( parent == NULL || child == NULL || parent->kind != bx_containerDesc || parentSlot == childSlot )
	{
		return;
	}
	if ( parent->childCount >= parent->childCapacity )
	{
		int capacity = parent->childCapacity == 0 ? 4 : parent->childCapacity * 2;
		parent->children = (bxChild*)realloc( parent->children, (size_t)capacity * sizeof( bxChild ) );
		parent->childCapacity = capacity;
	}
	bxChild* c = parent->children + parent->childCount;
	c->desc = childSlot;
	c->transform = bxTransform( px, py, pz, qx, qy, qz, qw );
	c->scale = bxVec3( sx, sy, sz );
	parent->childCount += 1;
}

BX_EXPORT void bx_ShapeDesc_RemoveChild( int parentSlot, int index )
{
	bxShapeDesc* parent = bxGetDesc( parentSlot );
	if ( parent == NULL || index < 0 || index >= parent->childCount )
	{
		return;
	}
	memmove( parent->children + index, parent->children + index + 1, (size_t)( parent->childCount - index - 1 ) * sizeof( bxChild ) );
	parent->childCount -= 1;
}

BX_EXPORT int bx_ShapeDesc_GetChildCount( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? 0 : desc->childCount;
}

BX_EXPORT int bx_ShapeDesc_GetKind( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? -1 : desc->kind;
}

BX_EXPORT void bx_ShapeDesc_SetMaterial( int slot, float friction, float restitution )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	if ( desc != NULL )
	{
		desc->friction = friction;
		desc->restitution = restitution;
	}
}

BX_EXPORT float bx_ShapeDesc_GetFriction( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? 0.0f : desc->friction;
}

BX_EXPORT float bx_ShapeDesc_GetRestitution( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? 0.0f : desc->restitution;
}

BX_EXPORT void bx_ShapeDesc_SetDensity( int slot, float density )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	if ( desc != NULL )
	{
		desc->density = density;
	}
}

BX_EXPORT float bx_ShapeDesc_GetDensity( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? 0.0f : desc->density;
}

BX_EXPORT void bx_ShapeDesc_SetFilter( int slot, unsigned int categoryBits, unsigned int maskBits )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	if ( desc != NULL )
	{
		desc->categoryBits = (uint64_t)categoryBits;
		desc->maskBits = (uint64_t)maskBits;
	}
}

BX_EXPORT unsigned int bx_ShapeDesc_GetCategoryBits( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? 0u : (unsigned int)( desc->categoryBits & 0xFFFFFFFFull );
}

BX_EXPORT unsigned int bx_ShapeDesc_GetMaskBits( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? 0u : (unsigned int)( desc->maskBits & 0xFFFFFFFFull );
}

/// Box2D style collision group: shapes sharing a negative group never collide, a positive group always collides.
BX_EXPORT void bx_ShapeDesc_SetGroup( int slot, int groupIndex )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	if ( desc != NULL )
	{
		desc->groupIndex = groupIndex;
	}
}

BX_EXPORT void bx_ShapeDesc_SetRollingResistance( int slot, float value )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	if ( desc != NULL )
	{
		desc->rollingResistance = value;
	}
}

BX_EXPORT void bx_ShapeDesc_SetSensor( int slot, int flag )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	if ( desc != NULL )
	{
		desc->isSensor = flag != 0;
	}
}

BX_EXPORT int bx_ShapeDesc_IsSensor( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	return desc == NULL ? 0 : desc->isSensor;
}

static b3AABB bxDescAABB( bxShapeDesc* desc, b3Transform xf, b3Vec3 scale, int depth )
{
	b3AABB aabb = { b3Vec3_zero, b3Vec3_zero };
	switch ( desc->kind )
	{
		case bx_sphereDesc:
		{
			b3Sphere s = desc->sphere;
			s.center = bxMulScale( s.center, scale );
			s.radius *= bxMaxAbsScale( scale );
			return b3ComputeSphereAABB( &s, xf );
		}
		case bx_capsuleDesc:
		{
			b3Capsule c = desc->capsule;
			c.center1 = bxMulScale( c.center1, scale );
			c.center2 = bxMulScale( c.center2, scale );
			c.radius *= bxMaxAbsScale( scale );
			return b3ComputeCapsuleAABB( &c, xf );
		}
		case bx_hullDesc:
		{
			b3AABB local = b3ComputeHullAABB( desc->hull, b3Transform_identity );
			b3Vec3 lo = bxMulScale( local.lowerBound, scale );
			b3Vec3 hi = bxMulScale( local.upperBound, scale );
			b3AABB scaled = { b3Min( lo, hi ), b3Max( lo, hi ) };
			// conservative: rotate the 8 corners
			b3Vec3 minP = { FLT_MAX, FLT_MAX, FLT_MAX };
			b3Vec3 maxP = { -FLT_MAX, -FLT_MAX, -FLT_MAX };
			for ( int i = 0; i < 8; ++i )
			{
				b3Vec3 corner = { ( i & 1 ) ? scaled.upperBound.x : scaled.lowerBound.x, ( i & 2 ) ? scaled.upperBound.y : scaled.lowerBound.y,
								  ( i & 4 ) ? scaled.upperBound.z : scaled.lowerBound.z };
				b3Vec3 p = b3Add( xf.p, b3RotateVector( xf.q, corner ) );
				minP = b3Min( minP, p );
				maxP = b3Max( maxP, p );
			}
			aabb.lowerBound = minP;
			aabb.upperBound = maxP;
			return aabb;
		}
		case bx_meshDesc:
			return b3ComputeMeshAABB( desc->mesh, xf, bxMulScale( desc->meshScale, scale ) );
		case bx_heightFieldDesc:
		{
			b3Transform offset = { desc->offset, b3Quat_identity };
			return b3ComputeHeightFieldAABB( desc->heightField, b3MulTransforms( xf, offset ) );
		}
		case bx_containerDesc:
		{
			int first = 1;
			if ( depth > 8 )
			{
				return aabb;
			}
			for ( int i = 0; i < desc->childCount; ++i )
			{
				bxShapeDesc* child = bxGetDesc( desc->children[i].desc );
				if ( child == NULL )
				{
					continue;
				}
				b3Transform childXf = b3MulTransforms( xf, desc->children[i].transform );
				b3AABB childBox = bxDescAABB( child, childXf, bxMulScale( scale, desc->children[i].scale ), depth + 1 );
				aabb = first ? childBox : b3AABB_Union( aabb, childBox );
				first = 0;
			}
			return aabb;
		}
		default:
			return aabb;
	}
}

/// scratch: [minx, miny, minz, maxx, maxy, maxz]
BX_EXPORT void bx_ShapeDesc_GetAABB( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	memset( s_scratch, 0, 6 * sizeof( float ) );
	if ( desc == NULL )
	{
		return;
	}
	b3AABB aabb = bxDescAABB( desc, b3Transform_identity, b3Vec3_one, 0 );
	bxWriteVec3( 0, aabb.lowerBound );
	bxWriteVec3( 3, aabb.upperBound );
}

static void bxFreeDescGeometry( bxShapeDesc* desc )
{
	if ( desc->hull != NULL )
	{
		b3DestroyHull( desc->hull );
		desc->hull = NULL;
	}
	if ( desc->mesh != NULL )
	{
		b3DestroyMesh( desc->mesh );
		desc->mesh = NULL;
	}
	if ( desc->heightField != NULL )
	{
		b3DestroyHeightField( desc->heightField );
		desc->heightField = NULL;
	}
}

BX_EXPORT void bx_ShapeDesc_Destroy( int slot )
{
	bxShapeDesc* desc = bxGetDesc( slot );
	if ( desc == NULL )
	{
		return;
	}
	free( desc->children );
	desc->children = NULL;
	desc->childCount = 0;
	desc->childCapacity = 0;
	desc->alive = 0;
	// hull data is copied into the world database so it is always safe to free.
	// mesh and height field data are referenced by live shapes, keep them until the last one goes.
	if ( desc->refCount <= 0 )
	{
		bxFreeDescGeometry( desc );
		memset( desc, 0, sizeof( bxShapeDesc ) );
		s_freeDescs[s_freeDescCount++] = slot;
	}
	else if ( desc->hull != NULL )
	{
		b3DestroyHull( desc->hull );
		desc->hull = NULL;
	}
}

static void bxDescRelease( int slot )
{
	if ( slot <= 0 || slot >= s_descCount )
	{
		return;
	}
	bxShapeDesc* desc = s_descs + slot;
	if ( desc->kind != bx_meshDesc && desc->kind != bx_heightFieldDesc )
	{
		return;
	}
	desc->refCount -= 1;
	if ( desc->alive == 0 && desc->refCount <= 0 )
	{
		bxFreeDescGeometry( desc );
		memset( desc, 0, sizeof( bxShapeDesc ) );
		s_freeDescs[s_freeDescCount++] = slot;
	}
}

// ---------------------------------------------------------------------------------------------
// Shape instantiation on bodies
// ---------------------------------------------------------------------------------------------

// Counts every box3d shape the shim has created. Rebuilding a shape description on its bodies is the expensive path,
// so this makes it observable (bx_GetShapeBuildCount).
static int s_shapeBuildCount;

BX_EXPORT int bx_GetShapeBuildCount( void )
{
	return s_shapeBuildCount;
}

/// Live shape descriptions, including the mesh copies baked for container children. Used to spot leaks.
BX_EXPORT int bx_GetShapeDescCount( void )
{
	int count = 0;
	for ( int i = 1; i < s_descCount; ++i )
	{
		if ( s_descs[i].alive != 0 || s_descs[i].refCount > 0 )
		{
			count += 1;
		}
	}
	return count;
}

/// descSlot is the description the shape belongs to, geomSlot the one owning the geometry it was built from (the same,
/// unless a transformed mesh copy was baked for this body).
static void bxBodyPushShape( bxBody* body, b3ShapeId shapeId, int descSlot, int geomSlot )
{
	if ( B3_IS_NULL( shapeId ) )
	{
		return;
	}
	s_shapeBuildCount += 1;
	if ( body->shapeCount >= body->shapeCapacity )
	{
		int capacity = body->shapeCapacity == 0 ? 4 : body->shapeCapacity * 2;
		body->shapes = (b3ShapeId*)realloc( body->shapes, (size_t)capacity * sizeof( b3ShapeId ) );
		body->shapeDescs = (int*)realloc( body->shapeDescs, (size_t)capacity * sizeof( int ) );
		body->geomDescs = (int*)realloc( body->geomDescs, (size_t)capacity * sizeof( int ) );
		body->shapeCapacity = capacity;
	}
	b3Shape_SetUserData( shapeId, (void*)(intptr_t)descSlot );
	body->shapes[body->shapeCount] = shapeId;
	body->shapeDescs[body->shapeCount] = descSlot;
	body->geomDescs[body->shapeCount] = geomSlot;
	body->shapeCount += 1;
	bxShapeDesc* geom = bxGetDesc( geomSlot );
	if ( geom != NULL && ( geom->kind == bx_meshDesc || geom->kind == bx_heightFieldDesc ) )
	{
		geom->refCount += 1;
	}
}

/// Box3D mesh shapes have no local transform, so a mesh inside a container is baked into a private transformed copy of
/// the mesh data. Returns a new description owning that copy, or 0.
static int bxBakeTransformedMesh( const bxShapeDesc* source, b3Transform xf, b3Vec3 scale )
{
	const b3Vec3* vertices = b3GetMeshVertices( source->mesh );
	const b3MeshTriangle* triangles = b3GetMeshTriangles( source->mesh );
	int vertexCount = source->mesh->vertexCount;
	int triangleCount = source->mesh->triangleCount;
	if ( vertices == NULL || triangles == NULL || vertexCount < 3 || triangleCount < 1 )
	{
		return 0;
	}
	b3Vec3* baked = (b3Vec3*)malloc( (size_t)vertexCount * sizeof( b3Vec3 ) );
	int32_t* indices = (int32_t*)malloc( (size_t)triangleCount * 3 * sizeof( int32_t ) );
	if ( baked == NULL || indices == NULL )
	{
		free( baked );
		free( indices );
		return 0;
	}
	for ( int i = 0; i < vertexCount; ++i )
	{
		baked[i] = b3Add( xf.p, b3RotateVector( xf.q, bxMulScale( vertices[i], scale ) ) );
	}
	// a mirroring scale flips the winding, so swap two indices to keep the triangles facing outwards
	int mirrored = scale.x * scale.y * scale.z < 0.0f;
	for ( int i = 0; i < triangleCount; ++i )
	{
		indices[3 * i + 0] = triangles[i].index1;
		indices[3 * i + 1] = mirrored ? triangles[i].index3 : triangles[i].index2;
		indices[3 * i + 2] = mirrored ? triangles[i].index2 : triangles[i].index3;
	}
	b3MeshDef def = { 0 };
	def.vertices = baked;
	def.vertexCount = vertexCount;
	def.indices = indices;
	def.triangleCount = triangleCount;
	def.identifyEdges = true;
	b3MeshData* mesh = b3CreateMesh( &def, NULL, 0 );
	free( baked );
	free( indices );
	if ( mesh == NULL )
	{
		return 0;
	}
	int slot = bxNewDesc( bx_meshDesc );
	s_descs[slot].mesh = mesh;
	return slot;
}

static void bxInstantiate( bxBody* body, int descSlot, b3Transform xf, b3Vec3 scale, int depth )
{
	bxShapeDesc* desc = bxGetDesc( descSlot );
	if ( desc == NULL || depth > 8 )
	{
		return;
	}

	b3ShapeDef def = b3DefaultShapeDef();
	def.density = desc->density;
	def.baseMaterial.friction = desc->friction;
	def.baseMaterial.restitution = desc->restitution;
	def.filter.categoryBits = desc->categoryBits;
	def.filter.maskBits = desc->maskBits;
	def.filter.groupIndex = desc->groupIndex;
	def.baseMaterial.rollingResistance = desc->rollingResistance;
	def.isSensor = desc->isSensor != 0;
	// Visitors must opt in to be seen by sensors. Babylon triggers see everything.
	def.enableSensorEvents = true;
	def.enableContactEvents = body->contactEvents != 0;
	def.enableHitEvents = body->hitEvents != 0;
	// the caller applies the mass once after instantiating every shape of the description
	def.updateBodyMass = false;

	switch ( desc->kind )
	{
		case bx_sphereDesc:
		{
			b3Sphere s = desc->sphere;
			s.center = b3Add( xf.p, b3RotateVector( xf.q, bxMulScale( s.center, scale ) ) );
			s.radius *= bxMaxAbsScale( scale );
			bxBodyPushShape( body, b3CreateSphereShape( body->id, &def, &s ), descSlot, descSlot );
			break;
		}
		case bx_capsuleDesc:
		{
			b3Capsule c = desc->capsule;
			c.center1 = b3Add( xf.p, b3RotateVector( xf.q, bxMulScale( c.center1, scale ) ) );
			c.center2 = b3Add( xf.p, b3RotateVector( xf.q, bxMulScale( c.center2, scale ) ) );
			c.radius *= bxMaxAbsScale( scale );
			bxBodyPushShape( body, b3CreateCapsuleShape( body->id, &def, &c ), descSlot, descSlot );
			break;
		}
		case bx_hullDesc:
		{
			if ( bxIsIdentity( xf, scale ) )
			{
				bxBodyPushShape( body, b3CreateHullShape( body->id, &def, desc->hull ), descSlot, descSlot );
			}
			else
			{
				bxBodyPushShape( body, b3CreateTransformedHullShape( body->id, &def, desc->hull, xf, scale ), descSlot, descSlot );
			}
			break;
		}
		case bx_meshDesc:
		{
			// Mesh shapes have no local transform in box3d, only a scale. A mesh that sits inside a container with an
			// offset or a rotation gets a transformed copy of its data baked for this body.
			b3Vec3 meshScale = bxMulScale( desc->meshScale, scale );
			if ( bxIsIdentity( xf, b3Vec3_one ) )
			{
				bxBodyPushShape( body, b3CreateMeshShape( body->id, &def, desc->mesh, meshScale ), descSlot, descSlot );
			}
			else
			{
				int baked = bxBakeTransformedMesh( desc, xf, meshScale );
				if ( baked != 0 )
				{
					b3ShapeId shapeId = b3CreateMeshShape( body->id, &def, s_descs[baked].mesh, b3Vec3_one );
					if ( B3_IS_NON_NULL( shapeId ) )
					{
						bxBodyPushShape( body, shapeId, descSlot, baked );
					}
					else
					{
						// nothing recorded the baked copy, so free it here instead of leaking the slot and its mesh
						bx_ShapeDesc_Destroy( baked );
					}
				}
			}
			break;
		}
		case bx_heightFieldDesc:
		{
			b3Transform offset = { desc->offset, b3Quat_identity };
			b3Transform local = b3MulTransforms( xf, offset );
			if ( bxIsIdentity( local, b3Vec3_one ) )
			{
				bxBodyPushShape( body, b3CreateHeightFieldShape( body->id, &def, desc->heightField ), descSlot, descSlot );
			}
			else
			{
				if ( body->helperCount >= body->helperCapacity )
				{
					int capacity = body->helperCapacity == 0 ? 2 : body->helperCapacity * 2;
					body->helpers = (bxHelper*)realloc( body->helpers, (size_t)capacity * sizeof( bxHelper ) );
					body->helperCapacity = capacity;
				}
				b3WorldTransform bodyXf = b3Body_GetTransform( body->id );
				b3Transform world = b3MulTransforms( bodyXf, local );
				b3BodyDef helperDef = b3DefaultBodyDef();
				helperDef.type = b3_staticBody;
				helperDef.position = world.p;
				helperDef.rotation = world.q;
				helperDef.userData = (void*)(intptr_t)( body - s_bodies );
				b3BodyId helperId = b3CreateBody( b3Body_GetWorld( body->id ), &helperDef );
				body->helpers[body->helperCount].id = helperId;
				body->helpers[body->helperCount].local = local;
				body->helperCount += 1;
				bxBodyPushShape( body, b3CreateHeightFieldShape( helperId, &def, desc->heightField ), descSlot, descSlot );
			}
			break;
		}
		case bx_containerDesc:
		{
			// Instantiating a child can bake a mesh, which allocates a description and may move the description table,
			// so `desc` must be re-fetched every iteration instead of being held across the recursion.
			for ( int i = 0;; ++i )
			{
				bxShapeDesc* container = bxGetDesc( descSlot );
				if ( container == NULL || i >= container->childCount )
				{
					break;
				}
				bxChild child = container->children[i];
				bxInstantiate( body, child.desc, b3MulTransforms( xf, child.transform ), bxMulScale( scale, child.scale ), depth + 1 );
			}
			break;
		}
		default:
			break;
	}
}

/// Replace all shapes on the body with an instantiation of the shape description (0 removes all shapes).
BX_EXPORT void bx_Body_SetShape( int slot, int descSlot )
{
	BX_BODY( slot );
	bxReleaseBodyShapes( body, 1 );
	body->shapeDesc = descSlot;
	if ( descSlot != 0 )
	{
		bxInstantiate( body, descSlot, b3Transform_identity, b3Vec3_one, 0 );
	}
	b3Body_ApplyMassFromShapes( body->id );
}

/// Properties that can be changed on live shapes, see bx_Body_SyncShapeDesc.
typedef enum bxSyncFlags
{
	bx_syncFilter = 1,
	bx_syncMaterial = 2,
	bx_syncDensity = 4,
} bxSyncFlags;

/// Applies changed description properties to the shapes this body already has, instead of rebuilding them. Rebuilding
/// loses contacts and re-applies the mass, and Babylon games change filters on live jointed bodies often.
BX_EXPORT void bx_Body_SyncShapeDesc( int slot, int descSlot, int what )
{
	BX_BODY( slot );
	bxShapeDesc* desc = bxGetDesc( descSlot );
	if ( desc == NULL )
	{
		return;
	}
	int massChanged = 0;
	for ( int i = 0; i < body->shapeCount; ++i )
	{
		if ( body->shapeDescs[i] != descSlot || b3Shape_IsValid( body->shapes[i] ) == false )
		{
			continue;
		}
		b3ShapeId shapeId = body->shapes[i];
		if ( what & bx_syncFilter )
		{
			b3Filter filter = b3Shape_GetFilter( shapeId );
			filter.categoryBits = desc->categoryBits;
			filter.maskBits = desc->maskBits;
			filter.groupIndex = desc->groupIndex;
			// true: contacts that the new filter forbids are dropped and new pairs are found on the next step
			b3Shape_SetFilter( shapeId, filter, true );
		}
		if ( what & bx_syncMaterial )
		{
			b3SurfaceMaterial material = b3Shape_GetSurfaceMaterial( shapeId );
			material.friction = desc->friction;
			material.restitution = desc->restitution;
			material.rollingResistance = desc->rollingResistance;
			b3Shape_SetSurfaceMaterial( shapeId, material );
		}
		if ( what & bx_syncDensity )
		{
			b3Shape_SetDensity( shapeId, desc->density, false );
			massChanged = 1;
		}
	}
	if ( massChanged )
	{
		b3Body_ApplyMassFromShapes( body->id );
	}
}

BX_EXPORT int bx_Body_GetShapeDesc( int slot )
{
	BX_BODY_RET( slot, 0 );
	return body->shapeDesc;
}

// ---------------------------------------------------------------------------------------------
// Debug geometry (for the physics viewer)
// ---------------------------------------------------------------------------------------------

static bxFloatBuffer s_debugPositions;
static int* s_debugIndices;
static int s_debugIndexCount;
static int s_debugIndexCapacity;

static void bxDebugPushVertex( b3Vec3 p )
{
	bxFloatBuffer_Reserve( &s_debugPositions, s_debugPositions.count + 3 );
	s_debugPositions.data[s_debugPositions.count++] = p.x;
	s_debugPositions.data[s_debugPositions.count++] = p.y;
	s_debugPositions.data[s_debugPositions.count++] = p.z;
}

static void bxDebugPushTriangle( int a, int b, int c )
{
	if ( s_debugIndexCount + 3 > s_debugIndexCapacity )
	{
		int capacity = s_debugIndexCapacity == 0 ? 256 : s_debugIndexCapacity * 2;
		while ( capacity < s_debugIndexCount + 3 )
		{
			capacity *= 2;
		}
		s_debugIndices = (int*)realloc( s_debugIndices, (size_t)capacity * sizeof( int ) );
		s_debugIndexCapacity = capacity;
	}
	s_debugIndices[s_debugIndexCount++] = a;
	s_debugIndices[s_debugIndexCount++] = b;
	s_debugIndices[s_debugIndexCount++] = c;
}

static void bxDebugHull( const b3HullData* hull, b3Transform xf, b3Vec3 scale )
{
	const b3Vec3* points = b3GetHullPoints( hull );
	const b3HullHalfEdge* edges = b3GetHullEdges( hull );
	const b3HullFace* faces = b3GetHullFaces( hull );
	for ( int f = 0; f < hull->faceCount; ++f )
	{
		int startEdge = faces[f].edge;
		int base = s_debugPositions.count / 3;
		int count = 0;
		int e = startEdge;
		do
		{
			b3Vec3 p = points[edges[e].origin];
			bxDebugPushVertex( b3Add( xf.p, b3RotateVector( xf.q, bxMulScale( p, scale ) ) ) );
			count += 1;
			e = edges[e].next;
		} while ( e != startEdge && count < 256 );
		for ( int i = 1; i + 1 < count; ++i )
		{
			bxDebugPushTriangle( base, base + i, base + i + 1 );
		}
	}
}

static void bxDebugDesc( int descSlot, b3Transform xf, b3Vec3 scale, int depth )
{
	bxShapeDesc* desc = bxGetDesc( descSlot );
	if ( desc == NULL || depth > 8 )
	{
		return;
	}
	switch ( desc->kind )
	{
		case bx_hullDesc:
			bxDebugHull( desc->hull, xf, scale );
			break;
		case bx_meshDesc:
		{
			int base = s_debugPositions.count / 3;
			const b3Vec3* vertices = b3GetMeshVertices( desc->mesh );
			const b3MeshTriangle* triangles = b3GetMeshTriangles( desc->mesh );
			b3Vec3 fullScale = bxMulScale( desc->meshScale, scale );
			for ( int i = 0; i < desc->mesh->vertexCount; ++i )
			{
				bxDebugPushVertex( b3Add( xf.p, b3RotateVector( xf.q, bxMulScale( vertices[i], fullScale ) ) ) );
			}
			for ( int i = 0; i < desc->mesh->triangleCount; ++i )
			{
				bxDebugPushTriangle( base + triangles[i].index1, base + triangles[i].index2, base + triangles[i].index3 );
			}
			break;
		}
		case bx_containerDesc:
			for ( int i = 0; i < desc->childCount; ++i )
			{
				bxChild child = desc->children[i];
				bxDebugDesc( child.desc, b3MulTransforms( xf, child.transform ), bxMulScale( scale, child.scale ), depth + 1 );
			}
			break;
		default:
			// spheres, capsules and height fields are drawn by the plugin from their parameters
			break;
	}
}

/// Builds triangle geometry for hulls and meshes in the description. Returns the vertex count.
BX_EXPORT int bx_ShapeDesc_BuildDebugGeometry( int slot )
{
	s_debugPositions.count = 0;
	s_debugIndexCount = 0;
	bxDebugDesc( slot, b3Transform_identity, b3Vec3_one, 0 );
	return s_debugPositions.count / 3;
}

BX_EXPORT float* bx_DebugPositionsPtr( void )
{
	return s_debugPositions.data;
}

BX_EXPORT int* bx_DebugIndicesPtr( void )
{
	return s_debugIndices;
}

BX_EXPORT int bx_DebugIndexCount( void )
{
	return s_debugIndexCount;
}

// ---------------------------------------------------------------------------------------------
// Joints
// ---------------------------------------------------------------------------------------------

typedef enum bxJointType
{
	bx_weldJoint = 0,
	bx_sphericalJoint = 1,
	bx_revoluteJoint = 2,
	bx_prismaticJoint = 3,
	bx_distanceJoint = 4,
	bx_filterJoint = 5,
	bx_wheelJoint = 6,
	bx_parallelJoint = 7,
} bxJointType;

/// Frames are read from scratch: [ax, ay, az, aqx, aqy, aqz, aqw, bx, by, bz, bqx, bqy, bqz, bqw]
/// Wheel joints read 16 more values from scratch[14..]: enableSuspension, suspensionHertz, suspensionDamping,
/// enableSuspensionLimit, lowerSuspension, upperSuspension, enableSpinMotor, maxSpinTorque, spinSpeed, enableSteering,
/// steeringHertz, steeringDamping, targetSteering, maxSteeringTorque, enableSteeringLimit, lowerSteering, upperSteering.
/// Parallel joints read [hertz, dampingRatio, maxTorque] from scratch[14..].
/// Returns the joint slot, 0 on failure.
// Fills the shared part of a joint definition. The definition must come from its b3Default*JointDef function so every
// field not set here keeps Box3D's default. In particular the force and torque thresholds default to FLT_MAX: a zeroed
// definition sets them to 0, which makes Box3D compute reaction forces and emit a joint event for every awake joint
// on every step.
static void bxFillJointBase( b3JointDef* base, bxBody* bodyA, bxBody* bodyB, int collideConnected )
{
	base->bodyIdA = bodyA->id;
	base->bodyIdB = bodyB->id;
	base->localFrameA = bxTransform( s_scratch[0], s_scratch[1], s_scratch[2], s_scratch[3], s_scratch[4], s_scratch[5], s_scratch[6] );
	base->localFrameB = bxTransform( s_scratch[7], s_scratch[8], s_scratch[9], s_scratch[10], s_scratch[11], s_scratch[12], s_scratch[13] );
	base->collideConnected = collideConnected != 0;
}

BX_EXPORT int bx_CreateJoint( int w, int type, int bodyASlot, int bodyBSlot, int collideConnected, float param )
{
	b3WorldId worldId = bxGetWorld( w );
	bxBody* bodyA = bxGetBody( bodyASlot );
	bxBody* bodyB = bxGetBody( bodyBSlot );
	if ( B3_IS_NULL( worldId ) || bodyA == NULL || bodyB == NULL )
	{
		return 0;
	}

	b3JointId jointId = b3_nullJointId;
	switch ( type )
	{
		case bx_weldJoint:
		{
			b3WeldJointDef def = b3DefaultWeldJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			jointId = b3CreateWeldJoint( worldId, &def );
			break;
		}
		case bx_sphericalJoint:
		{
			b3SphericalJointDef def = b3DefaultSphericalJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			jointId = b3CreateSphericalJoint( worldId, &def );
			break;
		}
		case bx_revoluteJoint:
		{
			b3RevoluteJointDef def = b3DefaultRevoluteJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			jointId = b3CreateRevoluteJoint( worldId, &def );
			break;
		}
		case bx_prismaticJoint:
		{
			b3PrismaticJointDef def = b3DefaultPrismaticJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			jointId = b3CreatePrismaticJoint( worldId, &def );
			break;
		}
		case bx_distanceJoint:
		{
			b3DistanceJointDef def = b3DefaultDistanceJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			def.length = param;
			def.enableLimit = true;
			def.minLength = param;
			def.maxLength = param;
			jointId = b3CreateDistanceJoint( worldId, &def );
			break;
		}
		case bx_wheelJoint:
		{
			b3WheelJointDef def = b3DefaultWheelJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			const float* p = s_scratch + 14;
			def.enableSuspensionSpring = p[0] != 0.0f;
			def.suspensionHertz = p[1];
			def.suspensionDampingRatio = p[2];
			def.enableSuspensionLimit = p[3] != 0.0f;
			def.lowerSuspensionLimit = p[4];
			def.upperSuspensionLimit = p[5];
			def.enableSpinMotor = p[6] != 0.0f;
			def.maxSpinTorque = p[7];
			def.spinSpeed = p[8];
			def.enableSteering = p[9] != 0.0f;
			def.steeringHertz = p[10];
			def.steeringDampingRatio = p[11];
			def.targetSteeringAngle = p[12];
			def.maxSteeringTorque = p[13];
			def.enableSteeringLimit = p[14] != 0.0f;
			def.lowerSteeringLimit = p[15];
			def.upperSteeringLimit = p[16];
			jointId = b3CreateWheelJoint( worldId, &def );
			break;
		}
		case bx_parallelJoint:
		{
			b3ParallelJointDef def = b3DefaultParallelJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			def.hertz = s_scratch[14];
			def.dampingRatio = s_scratch[15];
			def.maxTorque = s_scratch[16];
			jointId = b3CreateParallelJoint( worldId, &def );
			break;
		}
		case bx_filterJoint:
		{
			b3FilterJointDef def = b3DefaultFilterJointDef();
			bxFillJointBase( &def.base, bodyA, bodyB, collideConnected );
			jointId = b3CreateFilterJoint( worldId, &def );
			break;
		}
		default:
			return 0;
	}

	if ( B3_IS_NULL( jointId ) )
	{
		return 0;
	}
	int slot = bxAllocJoint();
	s_joints[slot].id = jointId;
	s_joints[slot].alive = 1;
	b3Joint_SetUserData( jointId, (void*)(intptr_t)slot );
	return slot;
}

BX_EXPORT void bx_DestroyJoint( int slot )
{
	if ( slot <= 0 || slot >= s_jointCount || s_joints[slot].alive == 0 )
	{
		return;
	}
	if ( b3Joint_IsValid( s_joints[slot].id ) )
	{
		b3DestroyJoint( s_joints[slot].id, true );
	}
	memset( s_joints + slot, 0, sizeof( bxJoint ) );
	s_freeJoints[s_freeJointCount++] = slot;
}

BX_EXPORT int bx_Joint_IsValid( int slot )
{
	return B3_IS_NON_NULL( bxGetJointId( slot ) ) ? 1 : 0;
}

BX_EXPORT void bx_Joint_SetCollideConnected( int slot, int flag )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) )
	{
		b3Joint_SetCollideConnected( id, flag != 0 );
	}
}

BX_EXPORT void bx_Joint_SetConstraintTuning( int slot, float hertz, float dampingRatio )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) )
	{
		b3Joint_SetConstraintTuning( id, hertz, dampingRatio );
	}
}

BX_EXPORT void bx_Joint_WakeBodies( int slot )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) )
	{
		b3Joint_WakeBodies( id );
	}
}

/// Enable or disable the primary limit of the joint (angle, translation, length, cone).
BX_EXPORT void bx_Joint_EnableLimit( int slot, int flag )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_EnableLimit( id, flag != 0 );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_EnableLimit( id, flag != 0 );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_EnableLimit( id, flag != 0 );
			break;
		case b3_sphericalJoint:
			b3SphericalJoint_EnableConeLimit( id, flag != 0 );
			break;
		default:
			break;
	}
}

BX_EXPORT void bx_Joint_SetLimits( int slot, float lower, float upper )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_SetLimits( id, lower, upper );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_SetLimits( id, lower, upper );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_SetLengthRange( id, lower, upper );
			break;
		case b3_sphericalJoint:
		{
			float cone = fabsf( upper ) > fabsf( lower ) ? fabsf( upper ) : fabsf( lower );
			b3SphericalJoint_SetConeLimit( id, cone );
			break;
		}
		default:
			break;
	}
}

/// Spherical joints only: twist limit about the frame z axis.
BX_EXPORT void bx_Joint_SetTwistLimits( int slot, int enable, float lower, float upper )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) || b3Joint_GetType( id ) != b3_sphericalJoint )
	{
		return;
	}
	b3SphericalJoint_EnableTwistLimit( id, enable != 0 );
	b3SphericalJoint_SetTwistLimits( id, lower, upper );
}

BX_EXPORT void bx_Joint_EnableMotor( int slot, int flag )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_EnableMotor( id, flag != 0 );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_EnableMotor( id, flag != 0 );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_EnableMotor( id, flag != 0 );
			break;
		case b3_sphericalJoint:
			b3SphericalJoint_EnableMotor( id, flag != 0 );
			break;
		default:
			break;
	}
}

/// Spherical joints take a relative angular velocity (angularVelocityB - angularVelocityA) in WORLD space. The target
/// is stored in joint frame A here and converted, so the motor keeps meaning the same thing as body A turns. Call
/// bx_Joint_UpdateMotorFrame once per step for joints with a non-zero target.
BX_EXPORT void bx_Joint_UpdateMotorFrame( int slot )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) || b3Joint_GetType( id ) != b3_sphericalJoint )
	{
		return;
	}
	b3Quat frameA = b3MulQuat( b3Body_GetRotation( b3Joint_GetBodyA( id ) ), b3Joint_GetLocalFrameA( id ).q );
	b3SphericalJoint_SetMotorVelocity( id, b3RotateVector( frameA, s_joints[slot].motorVelocity ) );
}

/// Enables the spherical motor with a target relative angular velocity in joint frame A (x, y, z) and a torque limit.
BX_EXPORT void bx_Joint_SetSphericalMotor( int slot, int enable, float x, float y, float z, float maxTorque )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) || b3Joint_GetType( id ) != b3_sphericalJoint )
	{
		return;
	}
	s_joints[slot].motorVelocity = bxVec3( x, y, z );
	b3SphericalJoint_EnableMotor( id, enable != 0 );
	b3SphericalJoint_SetMaxMotorTorque( id, maxTorque );
	bx_Joint_UpdateMotorFrame( slot );
}

/// Target rotation of a spherical joint's spring: frame B relative to frame A.
BX_EXPORT void bx_Joint_SetSphericalTarget( int slot, float qx, float qy, float qz, float qw )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) && b3Joint_GetType( id ) == b3_sphericalJoint )
	{
		b3SphericalJoint_SetTargetRotation( id, bxQuat( qx, qy, qz, qw ) );
	}
}

BX_EXPORT void bx_Joint_SetMotorSpeed( int slot, float speed )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_SetMotorSpeed( id, speed );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_SetMotorSpeed( id, speed );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_SetMotorSpeed( id, speed );
			break;
		case b3_sphericalJoint:
			// twist about the joint's own axis (frame z), not a world axis
			bx_Joint_SetSphericalMotor( slot, 1, 0.0f, 0.0f, speed, b3SphericalJoint_GetMaxMotorTorque( id ) );
			break;
		default:
			break;
	}
}

BX_EXPORT void bx_Joint_SetMaxMotorForce( int slot, float force )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_SetMaxMotorTorque( id, force );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_SetMaxMotorForce( id, force );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_SetMaxMotorForce( id, force );
			break;
		case b3_sphericalJoint:
			b3SphericalJoint_SetMaxMotorTorque( id, force );
			break;
		default:
			break;
	}
}

BX_EXPORT void bx_Joint_EnableSpring( int slot, int flag )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_EnableSpring( id, flag != 0 );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_EnableSpring( id, flag != 0 );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_EnableSpring( id, flag != 0 );
			break;
		case b3_sphericalJoint:
			b3SphericalJoint_EnableSpring( id, flag != 0 );
			break;
		default:
			break;
	}
}

BX_EXPORT void bx_Joint_SetSpring( int slot, float hertz, float dampingRatio )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_SetSpringHertz( id, hertz );
			b3RevoluteJoint_SetSpringDampingRatio( id, dampingRatio );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_SetSpringHertz( id, hertz );
			b3PrismaticJoint_SetSpringDampingRatio( id, dampingRatio );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_SetSpringHertz( id, hertz );
			b3DistanceJoint_SetSpringDampingRatio( id, dampingRatio );
			break;
		case b3_sphericalJoint:
			b3SphericalJoint_SetSpringHertz( id, hertz );
			b3SphericalJoint_SetSpringDampingRatio( id, dampingRatio );
			break;
		case b3_weldJoint:
			b3WeldJoint_SetLinearHertz( id, hertz );
			b3WeldJoint_SetLinearDampingRatio( id, dampingRatio );
			b3WeldJoint_SetAngularHertz( id, hertz );
			b3WeldJoint_SetAngularDampingRatio( id, dampingRatio );
			break;
		default:
			break;
	}
}

/// Position target: revolute angle (radians), prismatic translation, distance length.
BX_EXPORT void bx_Joint_SetTarget( int slot, float target )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			b3RevoluteJoint_SetTargetAngle( id, target );
			break;
		case b3_prismaticJoint:
			b3PrismaticJoint_SetTargetTranslation( id, target );
			break;
		case b3_distanceJoint:
			b3DistanceJoint_SetLength( id, target );
			break;
		default:
			break;
	}
}

BX_EXPORT float bx_Joint_GetPosition( int slot )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NULL( id ) )
	{
		return 0.0f;
	}
	switch ( b3Joint_GetType( id ) )
	{
		case b3_revoluteJoint:
			return b3RevoluteJoint_GetAngle( id );
		case b3_prismaticJoint:
			return b3PrismaticJoint_GetTranslation( id );
		case b3_distanceJoint:
			return b3DistanceJoint_GetLength( id );
		default:
			return 0.0f;
	}
}

/// Computes a local frame B on bodyB that coincides in world space with local frame A on bodyA.
/// Reads frame A from scratch[0..6] and the pivot of frame B from scratch[7..9], writes the frame B rotation
/// into scratch[10..13]. Used for joints whose frames must match at creation (wheel, weld).
BX_EXPORT void bx_ComputeAlignedFrameB( int bodyASlot, int bodyBSlot )
{
	bxBody* bodyA = bxGetBody( bodyASlot );
	bxBody* bodyB = bxGetBody( bodyBSlot );
	if ( bodyA == NULL || bodyB == NULL )
	{
		return;
	}
	b3Quat frameA = bxQuat( s_scratch[3], s_scratch[4], s_scratch[5], s_scratch[6] );
	b3Quat qA = b3Body_GetRotation( bodyA->id );
	b3Quat qB = b3Body_GetRotation( bodyB->id );
	b3Quat worldFrame = b3MulQuat( qA, frameA );
	b3Quat frameB = b3NormalizeQuat( b3InvMulQuat( qB, worldFrame ) );
	bxWriteQuat( 10, frameB );
}

BX_EXPORT void bx_WheelJoint_SetSpinMotorSpeed( int slot, float speed )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) && b3Joint_GetType( id ) == b3_wheelJoint )
	{
		b3WheelJoint_SetSpinMotorSpeed( id, speed );
		if ( speed != 0.0f )
		{
			b3Joint_WakeBodies( id );
		}
	}
}

BX_EXPORT void bx_WheelJoint_SetMaxSpinTorque( int slot, float torque )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) && b3Joint_GetType( id ) == b3_wheelJoint )
	{
		b3WheelJoint_SetMaxSpinTorque( id, torque );
	}
}

BX_EXPORT void bx_WheelJoint_EnableSpinMotor( int slot, int flag )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) && b3Joint_GetType( id ) == b3_wheelJoint )
	{
		b3WheelJoint_EnableSpinMotor( id, flag != 0 );
	}
}

BX_EXPORT void bx_WheelJoint_SetTargetSteeringAngle( int slot, float radians )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) && b3Joint_GetType( id ) == b3_wheelJoint )
	{
		b3WheelJoint_SetTargetSteeringAngle( id, radians );
		if ( radians != 0.0f )
		{
			b3Joint_WakeBodies( id );
		}
	}
}

BX_EXPORT void bx_WheelJoint_SetSuspension( int slot, float hertz, float dampingRatio )
{
	b3JointId id = bxGetJointId( slot );
	if ( B3_IS_NON_NULL( id ) && b3Joint_GetType( id ) == b3_wheelJoint )
	{
		b3WheelJoint_SetSuspensionHertz( id, hertz );
		b3WheelJoint_SetSuspensionDampingRatio( id, dampingRatio );
	}
}

// ---------------------------------------------------------------------------------------------
// Ray casts
// ---------------------------------------------------------------------------------------------

typedef struct bxRayContext
{
	int ignoreBody;
	int hitSensors;
	int closestOnly;
	int count;
} bxRayContext;

static bxFloatBuffer s_rayHits;
#define BX_RAY_HIT_STRIDE 11

BX_EXPORT float* bx_RayHitsPtr( void )
{
	return s_rayHits.data;
}

static float bxRayCallback( b3ShapeId shapeId, b3Pos point, b3Vec3 normal, float fraction, uint64_t userMaterialId, int triangleIndex,
							int childIndex, void* context )
{
	(void)userMaterialId;
	(void)childIndex;
	bxRayContext* ctx = (bxRayContext*)context;
	if ( ctx->hitSensors == 0 && b3Shape_IsSensor( shapeId ) )
	{
		return -1.0f;
	}
	int bodySlot = bxBodySlotFromShape( shapeId );
	if ( bodySlot == 0 || bodySlot == ctx->ignoreBody )
	{
		return -1.0f;
	}
	int index = ctx->closestOnly ? 0 : ctx->count;
	bxFloatBuffer_Reserve( &s_rayHits, ( index + 1 ) * BX_RAY_HIT_STRIDE );
	float* out = s_rayHits.data + index * BX_RAY_HIT_STRIDE;
	out[0] = point.x;
	out[1] = point.y;
	out[2] = point.z;
	out[3] = normal.x;
	out[4] = normal.y;
	out[5] = normal.z;
	out[6] = fraction;
	out[7] = (float)bodySlot;
	out[8] = (float)bxDescSlotFromShape( shapeId );
	out[9] = (float)triangleIndex;
	out[10] = 0.0f;
	ctx->count = ctx->closestOnly ? 1 : ctx->count + 1;
	return ctx->closestOnly ? fraction : 1.0f;
}

/// Casts a ray from origin along translation. Returns the number of hits written to bx_RayHitsPtr().
/// Each hit: [px, py, pz, nx, ny, nz, fraction, bodySlot, shapeDesc, triangleIndex, reserved]
BX_EXPORT int bx_World_CastRay( int w, float ox, float oy, float oz, float dx, float dy, float dz, unsigned int categoryBits,
								unsigned int maskBits, int ignoreBody, int hitSensors, int closestOnly )
{
	b3WorldId worldId = bxGetWorld( w );
	if ( B3_IS_NULL( worldId ) )
	{
		return 0;
	}
	bxRayContext ctx = { ignoreBody, hitSensors, closestOnly, 0 };
	b3QueryFilter filter = b3DefaultQueryFilter();
	filter.categoryBits = (uint64_t)categoryBits;
	filter.maskBits = (uint64_t)maskBits;
	b3World_CastRay( worldId, bxVec3( ox, oy, oz ), bxVec3( dx, dy, dz ), filter, bxRayCallback, &ctx );
	return ctx.count;
}
