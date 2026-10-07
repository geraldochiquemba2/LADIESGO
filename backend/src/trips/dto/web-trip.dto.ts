import { IsArray, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TripStopDto } from './request-trip.dto';

// Corpo do POST /trips/request-web — formato exato que a página web envia.
// (O ValidationPipe global rejeita props desconhecidas: declarar tudo.)
export class WebRequestTripDto {
  @IsString()
  @MaxLength(64)
  passengerId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  passengerName?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  pickupLat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  pickupLng!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pickupName?: string;

  @IsString()
  @MaxLength(60)
  destN!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  destA?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  destLat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  destLng!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fare?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  cat?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  pay?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => TripStopDto)
  stops?: TripStopDto[];

  @IsOptional()
  @IsNumber()
  scheduledAt?: number;
}

// Corpo do POST /trips/:id/status (página web).
export class TripStatusDto {
  @IsString()
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  by?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  driverId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  driverName?: string;
}

// Corpo do POST /trips/:id/chat (página web).
export class ChatPostDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsString()
  @MaxLength(300)
  text!: string;
}
